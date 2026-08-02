import Foundation
import WebKit

private struct URLProtocolAssetDescriptor: Decodable {
  let mediaType: String
  let originalUrl: String
  let path: String
  let responseHeaders: [String: String]?
  let responseUrl: String
  let size: Double
}

struct CachedDocument {
  let baseUrl: String
}

private struct CacheRequest: Decodable {
  let cacheDirectory: String
  let generationId: String?
  let maxBytes: Int64
  let securityPolicyFingerprint: String
  let validationMode: String
  let virtualUrl: String
}

private struct CacheGenerationSummary: Decodable {
  let generationId: String
  let securityPolicyFingerprint: String
  let totalBytes: Int64
}

private struct CacheState: Decodable {
  let activeGeneration: String
  let formatVersion: Int
  let generations: [CacheGenerationSummary]
}

private struct CachedAsset: Decodable {
  let delivery: String
  let localFile: String?
  let mediaType: String
  let responseHeaders: [String: String]?
  let responseUrl: String
  let sha256: String
  let size: Int64
  let url: String
}

private struct GenerationManifest: Decodable {
  let bundleEtag: String?
  let documentFragment: String
  let documentFragmentInherited: Bool
  let documentUrl: String
  let entryUrl: String
  let formatVersion: Int
  let generationId: String
  let remoteAssets: [CachedAsset]
  let securityPolicyFingerprint: String
  let totalBytes: Int64
  let validationMode: String
}

private struct URLProtocolByteRange {
  let end: UInt64
  let start: UInt64
}

private struct URLProtocolBasicAuthCredential {
  let password: String
  let username: String
}

private struct URLProtocolRegistry {
  let assets: [String: URLProtocolAssetDescriptor]
  let basicAuthCredential: URLProtocolBasicAuthCredential?
  let cookieStore: WKHTTPCookieStore
  let entryData: Data?
  let entryUrl: String?
  let origins: Set<String>
}

private struct URLProtocolRequestBody {
  let fileUrl: URL
  let ownerId: String
  var complete: Bool
  var size: UInt64
}

private final class LocalAssetURLSessionDelegate: NSObject, URLSessionDataDelegate {
  weak var owner: LocalAssetURLProtocol?

  init(owner: LocalAssetURLProtocol) {
    self.owner = owner
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    owner?.didReceiveNetworkResponse(response)
    completionHandler(.allow)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    owner?.didReceiveNetworkData(data)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    needNewBodyStream completionHandler: @escaping (InputStream?) -> Void
  ) {
    completionHandler(owner?.newNetworkBodyStream())
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (
      URLSession.AuthChallengeDisposition,
      URLCredential?
    ) -> Void
  ) {
    owner?.respond(to: challenge, completionHandler: completionHandler)
      ?? completionHandler(.performDefaultHandling, nil)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: (any Error)?
  ) {
    owner?.didCompleteNetworkRequest(error)
  }
}

final class LocalAssetURLProtocol: URLProtocol {
  static let requestBodyTokenHeader = "X-React-Native-Local-WebView-Body"

  private static let localStreamBytesPerSecond = 256 * 1024 * 1024
  private static let stateLock = NSLock()
  private static var installed = false
  private static var installationCount = 0
  private static var registries = [String: URLProtocolRegistry]()
  private static var registryOrder = [String]()
  private static var requestBodies = [String: URLProtocolRequestBody]()

  private let cancellationLock = NSLock()
  private var cancelled = false
  private var requestBasicAuthCredential: URLProtocolBasicAuthCredential?
  private var requestCookieStore: WKHTTPCookieStore?
  private var networkSession: URLSession?
  private var networkSessionDelegate: LocalAssetURLSessionDelegate?
  private var networkTask: URLSessionDataTask?
  private var networkBodyFileUrl: URL?
  private var workItem: DispatchWorkItem?

  static func install() -> String {
    stateLock.lock()
    defer { stateLock.unlock() }
    if installed {
      installationCount += 1
      return "HTTPS NSURLProtocol interception is already installed."
    }

    let selector = NSSelectorFromString("registerSchemeForCustomProtocol:")
    guard let controller = NSClassFromString("WKBrowsingContextController") as? NSObject.Type else {
      return "WKBrowsingContextController is unavailable."
    }
    guard controller.responds(to: selector) else {
      return "WKBrowsingContextController does not expose registerSchemeForCustomProtocol:."
    }

    controller.perform(selector, with: "https")
    URLProtocol.registerClass(LocalAssetURLProtocol.self)
    installed = true
    installationCount = 1
    return "Installed private HTTPS NSURLProtocol interception."
  }

  static func releaseInstallation() {
    stateLock.lock()
    guard installed, installationCount > 0 else {
      stateLock.unlock()
      return
    }
    installationCount -= 1
    guard installationCount == 0 else {
      stateLock.unlock()
      return
    }
    let selector = NSSelectorFromString("unregisterSchemeForCustomProtocol:")
    guard
      let controller = NSClassFromString("WKBrowsingContextController") as? NSObject.Type,
      controller.responds(to: selector)
    else {
      stateLock.unlock()
      return
    }
    controller.perform(selector, with: "https")
    URLProtocol.unregisterClass(LocalAssetURLProtocol.self)
    installed = false
    stateLock.unlock()
  }

  static func configure(
    assetsJson: String,
    baseUrl: String,
    basicAuthCredential: [String: Any]?,
    cookieStore: WKHTTPCookieStore,
    html: String,
    registryId: String
  ) throws -> Bool {
    let decoded = try JSONDecoder().decode(
      [URLProtocolAssetDescriptor].self,
      from: Data(assetsJson.utf8)
    )
    return register(
      assets: decoded,
      baseUrl: baseUrl,
      basicAuthCredential: basicAuthCredential,
      cookieStore: cookieStore,
      entryData: Data(html.utf8),
      registryId: registryId
    )
  }

  static func configureCachedBundle(
    cacheRequestJson: String,
    basicAuthCredential: [String: Any]?,
    cookieStore: WKHTTPCookieStore,
    registryId: String
  ) throws -> CachedDocument? {
    let decoder = JSONDecoder()
    let request = try decoder.decode(CacheRequest.self, from: Data(cacheRequestJson.utf8))
    guard
      request.maxBytes > 0,
      isHttps(request.virtualUrl),
      fingerprintPattern(request.securityPolicyFingerprint)
    else { return nil }
    let cacheDirectory = fileURL(request.cacheDirectory)
    let state = readCacheState(cacheDirectory, decoder: decoder)
    guard let state else { return nil }
    let orderedGenerationIds: [String]
    if let requested = request.generationId {
      orderedGenerationIds = [requested]
    } else {
      orderedGenerationIds = [state.activeGeneration] + state.generations
        .map(\.generationId)
        .filter { $0 != state.activeGeneration }
    }
    for generationId in orderedGenerationIds {
      guard
        generationPattern(generationId),
        let summary = state.generations.first(where: { $0.generationId == generationId }),
        summary.securityPolicyFingerprint == request.securityPolicyFingerprint,
        summary.totalBytes >= 0,
        summary.totalBytes <= request.maxBytes
      else { continue }
      let generationDirectory = cacheDirectory
        .appendingPathComponent("generations", isDirectory: true)
        .appendingPathComponent(generationId, isDirectory: true)
      let manifestURL = generationDirectory.appendingPathComponent("manifest.json")
      guard
        let manifestData = try? Data(contentsOf: manifestURL),
        let manifest = try? decoder.decode(GenerationManifest.self, from: manifestData),
        manifest.formatVersion == cacheFormatVersion,
        manifest.generationId == generationId,
        manifest.securityPolicyFingerprint == request.securityPolicyFingerprint,
        manifest.validationMode == request.validationMode,
        manifest.totalBytes == summary.totalBytes,
        normalized(manifest.entryUrl) == normalized(request.virtualUrl),
        request.validationMode != "release-etag" || !(manifest.bundleEtag ?? "").isEmpty
      else { continue }
      let sourceURL = generationDirectory.appendingPathComponent("index.html")
      guard let sourceData = try? Data(contentsOf: sourceURL) else { continue }
      var assets = [URLProtocolAssetDescriptor]()
      var valid = true
      for asset in manifest.remoteAssets where asset.delivery == "file" {
        guard
          fingerprintPattern(asset.sha256),
          asset.localFile == "assets/\(asset.sha256)",
          isHttps(asset.url),
          isHttps(asset.responseUrl),
          asset.size >= 0,
          let localFile = asset.localFile
        else {
          valid = false
          break
        }
        assets.append(
          URLProtocolAssetDescriptor(
            mediaType: asset.mediaType,
            originalUrl: asset.url,
            path: generationDirectory.appendingPathComponent(localFile).path,
            responseHeaders: asset.responseHeaders,
            responseUrl: asset.responseUrl,
            size: Double(asset.size)
          )
        )
      }
      guard valid, var components = URLComponents(string: manifest.documentUrl) else { continue }
      if manifest.documentFragmentInherited {
        components.percentEncodedFragment = URLComponents(string: request.virtualUrl)?
          .percentEncodedFragment
      } else {
        let fragment = String(manifest.documentFragment.drop(while: { $0 == "#" }))
        components.percentEncodedFragment = fragment.isEmpty ? nil : fragment
      }
      guard let runtimeURL = components.url?.absoluteString, isHttps(runtimeURL) else { continue }
      assets.append(
        URLProtocolAssetDescriptor(
          mediaType: "text/html",
          originalUrl: runtimeURL,
          path: sourceURL.path,
          responseHeaders: [:],
          responseUrl: runtimeURL,
          size: Double(sourceData.count)
        )
      )
      _ = register(
        assets: assets,
        baseUrl: runtimeURL,
        basicAuthCredential: basicAuthCredential,
        cookieStore: cookieStore,
        entryData: sourceData,
        registryId: registryId
      )
      return CachedDocument(baseUrl: runtimeURL)
    }
    return nil
  }

  private static func register(
    assets decoded: [URLProtocolAssetDescriptor],
    baseUrl: String,
    basicAuthCredential: [String: Any]?,
    cookieStore: WKHTTPCookieStore,
    entryData: Data,
    registryId: String
  ) -> Bool {
    var next = [String: URLProtocolAssetDescriptor]()
    var nextOrigins = Set<String>()
    for asset in decoded {
      next[normalized(asset.originalUrl)] = asset
      next[normalized(asset.responseUrl)] = asset
      if let origin = origin(of: asset.originalUrl) {
        nextOrigins.insert(origin)
      }
      if let origin = origin(of: asset.responseUrl) {
        nextOrigins.insert(origin)
      }
    }
    stateLock.lock()
    let normalizedEntryUrl = normalized(baseUrl)
    let hasEntry = next[normalizedEntryUrl] != nil
    if let baseOrigin = origin(of: baseUrl) {
      nextOrigins.insert(baseOrigin)
    }
    let credential = basicAuthCredential.flatMap { value -> URLProtocolBasicAuthCredential? in
      guard
        let username = value["username"] as? String,
        let password = value["password"] as? String
      else {
        return nil
      }
      return URLProtocolBasicAuthCredential(password: password, username: username)
    }
    registries[registryId] = URLProtocolRegistry(
      assets: next,
      basicAuthCredential: credential,
      cookieStore: cookieStore,
      entryData: hasEntry ? entryData : nil,
      entryUrl: hasEntry ? normalizedEntryUrl : nil,
      origins: nextOrigins
    )
    registryOrder.removeAll { $0 == registryId }
    registryOrder.append(registryId)
    stateLock.unlock()
    return hasEntry
  }

  private static let cacheFormatVersion = 14

  private static func fileURL(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path), url.isFileURL { return url }
    return URL(fileURLWithPath: path, isDirectory: true)
  }

  private static func fingerprintPattern(_ value: String) -> Bool {
    value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
  }

  private static func generationPattern(_ value: String) -> Bool {
    value.range(
      of: #"^\d+-\d+-[a-f0-9]{8}-[a-f0-9]{8}$"#,
      options: .regularExpression
    ) != nil
  }

  private static func isHttps(_ value: String) -> Bool {
    URL(string: value)?.scheme?.lowercased() == "https"
  }

  private static func readCacheState(
    _ cacheDirectory: URL,
    decoder: JSONDecoder
  ) -> CacheState? {
    for name in ["state.json", "state.previous.json"] {
      let url = cacheDirectory.appendingPathComponent(name)
      guard
        let data = try? Data(contentsOf: url),
        let state = try? decoder.decode(CacheState.self, from: data),
        state.formatVersion == cacheFormatVersion,
        generationPattern(state.activeGeneration),
        state.generations.contains(where: { $0.generationId == state.activeGeneration }),
        state.generations.allSatisfy({
          generationPattern($0.generationId) &&
            fingerprintPattern($0.securityPolicyFingerprint) && $0.totalBytes >= 0
        })
      else { continue }
      return state
    }
    return nil
  }

  static func unregister(registryId: String) {
    stateLock.lock()
    registries.removeValue(forKey: registryId)
    registryOrder.removeAll { $0 == registryId }
    let bodyFiles = requestBodies.values
      .filter { $0.ownerId == registryId }
      .map(\.fileUrl)
    requestBodies = requestBodies.filter { $0.value.ownerId != registryId }
    stateLock.unlock()
    for fileUrl in bodyFiles {
      try? FileManager.default.removeItem(at: fileUrl)
    }
  }

  static func updateRequestBody(
    ownerId: String,
    message: Any
  ) throws {
    guard let value = message as? [String: Any],
      let token = value["token"] as? String,
      token.range(
        of: #"^[A-Za-z0-9-]{16,128}$"#,
        options: .regularExpression
      ) != nil
    else {
      throw urlProtocolError("Invalid WebView request-body token.")
    }
    if value["cancel"] as? Bool == true {
      stateLock.lock()
      let fileUrl = requestBodies.removeValue(forKey: token)?.fileUrl
      stateLock.unlock()
      if let fileUrl {
        try? FileManager.default.removeItem(at: fileUrl)
      }
      return
    }
    if value["start"] as? Bool == true {
      let fileUrl = FileManager.default.temporaryDirectory
        .appendingPathComponent("react-native-local-webview-\(UUID().uuidString).body")
      guard FileManager.default.createFile(atPath: fileUrl.path, contents: nil) else {
        throw urlProtocolError("Unable to create a temporary WebView request-body file.")
      }
      stateLock.lock()
      let previous = requestBodies.updateValue(
        URLProtocolRequestBody(
          fileUrl: fileUrl,
          ownerId: ownerId,
          complete: false,
          size: 0
        ),
        forKey: token
      )?.fileUrl
      stateLock.unlock()
      if let previous {
        try? FileManager.default.removeItem(at: previous)
      }
    }
    if let encoded = value["chunk"] as? String {
      guard let data = Data(base64Encoded: encoded) else {
        throw urlProtocolError("Invalid base64 WebView request-body chunk.")
      }
      stateLock.lock()
      guard var body = requestBodies[token], body.ownerId == ownerId, !body.complete else {
        stateLock.unlock()
        throw urlProtocolError("Unknown or completed WebView request-body token.")
      }
      let nextSize = body.size + UInt64(data.count)
      guard nextSize <= 2 * 1024 * 1024 * 1024 else {
        requestBodies.removeValue(forKey: token)
        stateLock.unlock()
        try? FileManager.default.removeItem(at: body.fileUrl)
        throw urlProtocolError("WebView request body exceeded 2 GiB.")
      }
      do {
        let file = try FileHandle(forWritingTo: body.fileUrl)
        defer { try? file.close() }
        try file.seekToEnd()
        try file.write(contentsOf: data)
        body.size = nextSize
        requestBodies[token] = body
        stateLock.unlock()
      } catch {
        requestBodies.removeValue(forKey: token)
        stateLock.unlock()
        try? FileManager.default.removeItem(at: body.fileUrl)
        throw error
      }
    }
    if value["complete"] as? Bool == true {
      stateLock.lock()
      guard var body = requestBodies[token], body.ownerId == ownerId else {
        stateLock.unlock()
        throw urlProtocolError("Unknown WebView request-body token.")
      }
      body.complete = true
      requestBodies[token] = body
      stateLock.unlock()
    }
  }

  override class func canInit(with request: URLRequest) -> Bool {
    guard let url = request.url, url.scheme?.lowercased() == "https" else {
      return false
    }
    return registry(for: url) != nil
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override class func requestIsCacheEquivalent(
    _ a: URLRequest,
    to b: URLRequest
  ) -> Bool {
    a.url == b.url
  }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: runtimeError("Missing asset URL."))
      return
    }
    let registry = Self.registry(for: url)
    requestBasicAuthCredential = registry?.basicAuthCredential
    requestCookieStore = registry?.cookieStore
    let method = request.httpMethod?.uppercased() ?? "GET"
    let asset = registry?.assets[Self.normalized(url.absoluteString)]
    guard let asset, method == "GET" || method == "HEAD" else {
      startNetworkRequest()
      return
    }

    let item = DispatchWorkItem { [weak self] in
      if registry?.entryUrl == Self.normalized(url.absoluteString),
        let data = registry?.entryData
      {
        self?.serve(data, mediaType: asset.mediaType, requestUrl: url)
      } else {
        self?.serve(asset, requestUrl: url)
      }
    }
    workItem = item
    DispatchQueue.global(qos: .userInitiated).async(execute: item)
  }

  override func stopLoading() {
    cancellationLock.lock()
    cancelled = true
    cancellationLock.unlock()
    workItem?.cancel()
    networkTask?.cancel()
    networkSession?.invalidateAndCancel()
    removeNetworkBodyFile()
  }

  private func serve(_ asset: URLProtocolAssetDescriptor, requestUrl: URL) {
    do {
      let fileUrl = URL(fileURLWithPath: asset.path)
      let values = try fileUrl.resourceValues(forKeys: [.fileSizeKey])
      guard let signedSize = values.fileSize, signedSize >= 0 else {
        throw runtimeError("The local asset size is unavailable.")
      }
      let fileSize = UInt64(signedSize)
      guard asset.size >= 0, UInt64(asset.size) == fileSize else {
        throw runtimeError(
          "Local asset size mismatch for \(asset.originalUrl): expected \(asset.size), found \(fileSize)."
        )
      }

      let rangeHeader = request.value(forHTTPHeaderField: "Range")
      guard let range = parseRange(rangeHeader, size: fileSize) else {
        let headers = [
          "Accept-Ranges": "bytes",
          "Content-Length": "0",
          "Content-Range": "bytes */\(fileSize)",
          "Content-Type": asset.mediaType,
        ]
        sendResponse(requestUrl, statusCode: 416, headers: headers)
        client?.urlProtocolDidFinishLoading(self)
        return
      }

      let partial = !(rangeHeader?.isEmpty ?? true)
      let length = range.end - range.start
      var headers = asset.responseHeaders ?? [:]
      headers["Accept-Ranges"] = "bytes"
      headers["Cache-Control"] = "no-store"
      headers["Content-Length"] = String(length)
      headers["Content-Type"] = asset.mediaType
      headers["X-Content-Type-Options"] = "nosniff"
      if partial {
        headers["Content-Range"] =
          "bytes \(range.start)-\(range.end - 1)/\(fileSize)"
      }
      sendResponse(
        requestUrl,
        statusCode: partial ? 206 : 200,
        headers: headers
      )

      if request.httpMethod?.uppercased() != "HEAD", length > 0 {
        let file = try FileHandle(forReadingFrom: fileUrl)
        defer { try? file.close() }
        try file.seek(toOffset: range.start)
        let streamStartedAt = ProcessInfo.processInfo.systemUptime
        var deliveredBytes: UInt64 = 0
        var remaining = length
        while remaining > 0 {
          guard !isCancelled else { return }
          let requested = Int(min(remaining, 1024 * 1024))
          let delivered = try autoreleasepool {
            guard let data = try file.read(upToCount: requested), !data.isEmpty else {
              throw runtimeError("The local asset ended before its declared range.")
            }
            client?.urlProtocol(self, didLoad: data)
            return data.count
          }
          let deliveredCount = UInt64(delivered)
          deliveredBytes += deliveredCount
          remaining -= deliveredCount
          // NSURLProtocol has no consumer-backpressure signal. Without a
          // bounded producer, a fast local disk can enqueue an entire Unity
          // payload in WebKit before the content process consumes it.
          let targetElapsed =
            Double(deliveredBytes) / Double(Self.localStreamBytesPerSecond)
          let delay =
            targetElapsed - (ProcessInfo.processInfo.systemUptime - streamStartedAt)
          if delay > 0 {
            Thread.sleep(forTimeInterval: delay)
          }
        }
      }
      guard !isCancelled else { return }
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      guard !isCancelled else { return }
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  private func serve(_ data: Data, mediaType: String, requestUrl: URL) {
    let size = UInt64(data.count)
    let rangeHeader = request.value(forHTTPHeaderField: "Range")
    guard let range = parseRange(rangeHeader, size: size) else {
      sendResponse(
        requestUrl,
        statusCode: 416,
        headers: [
          "Accept-Ranges": "bytes",
          "Content-Length": "0",
          "Content-Range": "bytes */\(size)",
          "Content-Type": mediaType,
        ]
      )
      client?.urlProtocolDidFinishLoading(self)
      return
    }
    let partial = !(rangeHeader?.isEmpty ?? true)
    let length = range.end - range.start
    var headers = [
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(length),
      "Content-Type": mediaType,
      "X-Content-Type-Options": "nosniff",
    ]
    if partial {
      headers["Content-Range"] =
        "bytes \(range.start)-\(range.end - 1)/\(size)"
    }
    sendResponse(
      requestUrl,
      statusCode: partial ? 206 : 200,
      headers: headers
    )
    if request.httpMethod?.uppercased() != "HEAD", length > 0 {
      let lower = Int(range.start)
      let upper = Int(range.end)
      client?.urlProtocol(self, didLoad: data.subdata(in: lower..<upper))
    }
    guard !isCancelled else { return }
    client?.urlProtocolDidFinishLoading(self)
  }

  private var isCancelled: Bool {
    cancellationLock.lock()
    defer { cancellationLock.unlock() }
    return cancelled || workItem?.isCancelled == true
  }

  private func sendResponse(
    _ url: URL,
    statusCode: Int,
    headers: [String: String]
  ) {
    guard
      let response = HTTPURLResponse(
        url: url,
        statusCode: statusCode,
        httpVersion: "HTTP/1.1",
        headerFields: headers
      )
    else {
      return
    }
    client?.urlProtocol(
      self,
      didReceive: response,
      cacheStoragePolicy: .notAllowed
    )
  }

  private func startNetworkRequest() {
    if let requestCookieStore {
      requestCookieStore.getAllCookies { [weak self] cookies in
        self?.startNetworkRequest(cookies: cookies)
      }
    } else {
      startNetworkRequest(cookies: [])
    }
  }

  private func startNetworkRequest(cookies: [HTTPCookie]) {
    guard !isCancelled, let url = request.url else { return }
    var networkRequest = request
    if let token = networkRequest.value(
      forHTTPHeaderField: Self.requestBodyTokenHeader
    ) {
      guard let bodyFileUrl = Self.claimRequestBody(token: token) else {
        client?.urlProtocol(
          self,
          didFailWithError: runtimeError("The captured WebView request body is unavailable.")
        )
        return
      }
      networkBodyFileUrl = bodyFileUrl
      networkRequest.setValue(nil, forHTTPHeaderField: Self.requestBodyTokenHeader)
      networkRequest.httpBodyStream = InputStream(url: bodyFileUrl)
      if let size = try? bodyFileUrl.resourceValues(forKeys: [.fileSizeKey]).fileSize {
        networkRequest.setValue(String(size), forHTTPHeaderField: "Content-Length")
      }
    } else if networkRequest.httpBody == nil, let bodyStream = networkRequest.httpBodyStream {
      do {
        let bodyFileUrl = try copyBodyStreamToTemporaryFile(bodyStream)
        networkBodyFileUrl = bodyFileUrl
        networkRequest.httpBodyStream = InputStream(url: bodyFileUrl)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
        return
      }
    }
    if networkRequest.httpShouldHandleCookies,
      networkRequest.value(forHTTPHeaderField: "Cookie") == nil
    {
      let matching = cookies.filter { Self.cookie($0, matches: url) }
      let fields = HTTPCookie.requestHeaderFields(with: matching)
      for (name, value) in fields {
        networkRequest.setValue(value, forHTTPHeaderField: name)
      }
    }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.protocolClasses = []
    let delegate = LocalAssetURLSessionDelegate(owner: self)
    let session = URLSession(
      configuration: configuration,
      delegate: delegate,
      delegateQueue: nil
    )
    let task = session.dataTask(with: networkRequest)
    networkSessionDelegate = delegate
    networkSession = session
    networkTask = task
    task.resume()
  }

  fileprivate func didReceiveNetworkResponse(_ response: URLResponse) {
    guard !isCancelled else { return }
    if let response = response as? HTTPURLResponse,
      let url = response.url
    {
      var fields = [String: String]()
      for (name, value) in response.allHeaderFields {
        fields[String(describing: name)] = String(describing: value)
      }
      let cookies = HTTPCookie.cookies(
        withResponseHeaderFields: fields,
        for: url
      )
      for cookie in cookies {
        requestCookieStore?.setCookie(cookie)
      }
    }
    client?.urlProtocol(
      self,
      didReceive: response,
      cacheStoragePolicy: .notAllowed
    )
  }

  fileprivate func respond(
    to challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (
      URLSession.AuthChallengeDisposition,
      URLCredential?
    ) -> Void
  ) {
    guard
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodHTTPBasic,
      challenge.previousFailureCount == 0,
      let credential = requestBasicAuthCredential
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    completionHandler(
      .useCredential,
      URLCredential(
        user: credential.username,
        password: credential.password,
        persistence: .none
      )
    )
  }

  fileprivate func didReceiveNetworkData(_ data: Data) {
    guard !isCancelled else { return }
    client?.urlProtocol(self, didLoad: data)
  }

  fileprivate func didCompleteNetworkRequest(_ error: (any Error)?) {
    guard !isCancelled else { return }
    if let error {
      client?.urlProtocol(self, didFailWithError: error)
    } else {
      client?.urlProtocolDidFinishLoading(self)
    }
    networkSession?.finishTasksAndInvalidate()
    networkSession = nil
    networkSessionDelegate = nil
    networkTask = nil
    removeNetworkBodyFile()
  }

  fileprivate func newNetworkBodyStream() -> InputStream? {
    guard let networkBodyFileUrl else { return nil }
    return InputStream(url: networkBodyFileUrl)
  }

  private func copyBodyStreamToTemporaryFile(_ stream: InputStream) throws -> URL {
    let fileUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("react-native-local-webview-\(UUID().uuidString).body")
    guard FileManager.default.createFile(atPath: fileUrl.path, contents: nil) else {
      throw runtimeError("Unable to create a temporary WebView request-body file.")
    }
    do {
      let file = try FileHandle(forWritingTo: fileUrl)
      defer { try? file.close() }
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count == 0 {
          break
        }
        if count < 0 {
          throw stream.streamError
            ?? runtimeError("Unable to read the WebView request-body stream.")
        }
        try file.write(contentsOf: Data(buffer[0..<count]))
      }
      return fileUrl
    } catch {
      try? FileManager.default.removeItem(at: fileUrl)
      throw error
    }
  }

  private func removeNetworkBodyFile() {
    guard let fileUrl = networkBodyFileUrl else { return }
    networkBodyFileUrl = nil
    try? FileManager.default.removeItem(at: fileUrl)
  }

  private static func claimRequestBody(token: String) -> URL? {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard let body = requestBodies[token], body.complete else { return nil }
    requestBodies.removeValue(forKey: token)
    return body.fileUrl
  }

  private func parseRange(_ header: String?, size: UInt64) -> URLProtocolByteRange? {
    guard let header, !header.isEmpty else {
      return URLProtocolByteRange(end: size, start: 0)
    }
    guard size > 0 else { return nil }
    guard header.lowercased().hasPrefix("bytes=") else { return nil }
    let value = header.dropFirst(6)
    guard !value.contains(","), let separator = value.firstIndex(of: "-") else {
      return nil
    }
    let startText = value[..<separator]
    let endText = value[value.index(after: separator)...]
    if startText.isEmpty {
      guard let suffix = UInt64(endText), suffix > 0 else { return nil }
      let length = min(suffix, size)
      return URLProtocolByteRange(end: size, start: size - length)
    }
    guard let start = UInt64(startText), start < size else { return nil }
    if endText.isEmpty {
      return URLProtocolByteRange(end: size, start: start)
    }
    guard let inclusiveEnd = UInt64(endText), inclusiveEnd >= start else {
      return nil
    }
    let exclusiveEnd =
      inclusiveEnd >= size - 1
      ? size
      : inclusiveEnd + 1
    return URLProtocolByteRange(
      end: exclusiveEnd,
      start: start
    )
  }

  private static func normalized(_ url: String) -> String {
    guard var components = URLComponents(string: url) else { return url }
    components.fragment = nil
    return components.url?.absoluteString ?? url
  }

  private static func registry(for url: URL) -> URLProtocolRegistry? {
    let normalizedUrl = normalized(url.absoluteString)
    let requestOrigin = origin(of: url)
    stateLock.lock()
    defer { stateLock.unlock() }
    // NSURLProtocol registration is process-wide. Prefer an exact local asset
    // match before selecting an origin context for network pass-through, so a
    // newer view at the same origin cannot steal unrelated local paths.
    for registryId in registryOrder.reversed() {
      guard let registry = registries[registryId] else { continue }
      if registry.assets[normalizedUrl] != nil {
        return registry
      }
    }
    for registryId in registryOrder.reversed() {
      guard let registry = registries[registryId] else { continue }
      if registry.origins.contains(requestOrigin ?? "") {
        return registry
      }
    }
    return nil
  }

  private static func origin(of value: String) -> String? {
    guard let url = URL(string: value) else { return nil }
    return origin(of: url)
  }

  private static func origin(of url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
      return nil
    }
    var result = "\(scheme)://\(host)"
    if let port = url.port {
      result += ":\(port)"
    }
    return result
  }

  private static func cookie(_ cookie: HTTPCookie, matches url: URL) -> Bool {
    guard let host = url.host?.lowercased() else { return false }
    let domain = cookie.domain.lowercased()
    let domainMatches =
      domain.hasPrefix(".")
      ? host == String(domain.dropFirst()) || host.hasSuffix(domain)
      : host == domain
    guard domainMatches else { return false }
    let requestPath = url.path.isEmpty ? "/" : url.path
    let cookiePath = cookie.path.isEmpty ? "/" : cookie.path
    let pathMatches =
      requestPath == cookiePath
      || (requestPath.hasPrefix(cookiePath)
        && (cookiePath.hasSuffix("/")
          || requestPath.dropFirst(cookiePath.count).first == "/"))
    guard pathMatches else { return false }
    if cookie.isSecure && url.scheme?.lowercased() != "https" {
      return false
    }
    if let expires = cookie.expiresDate, expires <= Date() {
      return false
    }
    return true
  }

  private func runtimeError(_ message: String) -> NSError {
    NSError(
      domain: "ReactNativeLocalWebView.URLProtocol",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}

private func urlProtocolError(_ message: String) -> NSError {
  NSError(
    domain: "ReactNativeLocalWebView.URLProtocol",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
