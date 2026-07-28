import CryptoKit
import Foundation
import NitroModules

private enum LocalWebViewCacheError: Error, LocalizedError {
  case invalidEncoding(String)
  case invalidRange
  case invalidRequest
  case nonHTTPResponse
  case responseTooLarge(url: String, maximum: Int64, observed: Int64)

  var errorDescription: String? {
    switch self {
    case .invalidEncoding(let encoding):
      "Unsupported file encoding: \(encoding)"
    case .invalidRange:
      "The requested file range is invalid."
    case .invalidRequest:
      "The native cache download request is invalid."
    case .nonHTTPResponse:
      "The cache downloader received a non-HTTP response."
    case .responseTooLarge(let url, let maximum, let observed):
      "LOCAL_WEBVIEW_DOWNLOAD_LIMIT|\(maximum)|\(observed)|\(url)"
    }
  }
}

private struct LocalWebViewDownloadRequest: Decodable {
  let hashAlgorithms: [String]?
  let headers: [String: String]?
  let maxBytes: Int64?
  let path: String
  let timeoutMs: Double
  let url: String
}

private struct LocalWebViewDownloadResponse: Encodable {
  let bytesWritten: Int64
  let digests: [String: String]?
  let headers: [String: String]
  let responseUrl: String
  let status: Int
  let wroteFile: Bool
}

private func cacheFileURL(_ path: String) -> URL {
  if path.hasPrefix("file://"), let url = URL(string: path), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: path)
}

private func ensureCacheParent(of url: URL) throws {
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
}

private func hexadecimal<D: Digest>(_ digest: D) -> String {
  digest.map { String(format: "%02x", $0) }.joined()
}

private let downloadWriteBufferBytes = 256 * 1024

private final class LocalWebViewDownloadContext {
  let destination: URL
  var failure: Error?
  var fileHandle: FileHandle?
  let maximumBytes: Int64?
  var pendingData = Data()
  let promise: Promise<String>
  var receivedBytes: Int64 = 0
  var response: HTTPURLResponse?
  var sha256: SHA256?
  var sha384: SHA384?
  var sha512: SHA512?
  let requestId: String
  let sourceUrl: String
  var timeoutWorkItem: DispatchWorkItem?
  var wroteFile = false

  init(
    destination: URL,
    hashAlgorithms: [String],
    maximumBytes: Int64?,
    promise: Promise<String>,
    requestId: String,
    sourceUrl: String
  ) {
    self.destination = destination
    self.maximumBytes = maximumBytes
    self.promise = promise
    self.requestId = requestId
    let requested = Set(hashAlgorithms)
    sha256 = requested.contains("sha256") ? SHA256() : nil
    sha384 = requested.contains("sha384") ? SHA384() : nil
    sha512 = requested.contains("sha512") ? SHA512() : nil
    self.sourceUrl = sourceUrl
    pendingData.reserveCapacity(downloadWriteBufferBytes)
  }

  func flushPendingData() throws {
    guard !pendingData.isEmpty else { return }
    updateDigests(with: pendingData)
    try fileHandle?.write(contentsOf: pendingData)
    pendingData.removeAll(keepingCapacity: true)
  }

  func updateDigests(with data: Data) {
    sha256?.update(data: data)
    sha384?.update(data: data)
    sha512?.update(data: data)
  }

  func finalizeDigests() -> [String: String]? {
    var result = [String: String]()
    if let digest = sha256?.finalize() { result["sha256"] = hexadecimal(digest) }
    if let digest = sha384?.finalize() { result["sha384"] = hexadecimal(digest) }
    if let digest = sha512?.finalize() { result["sha512"] = hexadecimal(digest) }
    return result.isEmpty ? nil : result
  }
}

private final class LocalWebViewDownloadClient: NSObject, URLSessionDataDelegate {
  private var activeTasks = [String: URLSessionDataTask]()
  private var contexts = [Int: LocalWebViewDownloadContext]()
  private let lock = NSLock()
  private let sessionDelegateQueue: OperationQueue
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    return URLSession(
      configuration: configuration,
      delegate: self,
      delegateQueue: sessionDelegateQueue
    )
  }()

  override init() {
    sessionDelegateQueue = OperationQueue()
    sessionDelegateQueue.maxConcurrentOperationCount = 1
    sessionDelegateQueue.name = "react-native-local-webview.downloads"
    super.init()
  }

  func download(
    requestId: String,
    request: LocalWebViewDownloadRequest,
    url: URL
  ) -> Promise<String> {
    let promise = Promise<String>()
    let context = LocalWebViewDownloadContext(
      destination: cacheFileURL(request.path),
      hashAlgorithms: request.hashAlgorithms ?? [],
      maximumBytes: request.maxBytes,
      promise: promise,
      requestId: requestId,
      sourceUrl: request.url
    )
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = "GET"
    urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
    urlRequest.timeoutInterval = request.timeoutMs / 1000
    urlRequest.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.headers?.forEach { urlRequest.setValue($0.value, forHTTPHeaderField: $0.key) }
    let task = session.dataTask(with: urlRequest)
    let timeoutWorkItem = DispatchWorkItem { [weak self] in
      self?.failAndCancel(
        requestId: requestId,
        error: URLError(.timedOut)
      )
    }
    context.timeoutWorkItem = timeoutWorkItem

    lock.lock()
    let existing = activeTasks.updateValue(task, forKey: requestId)
    contexts[task.taskIdentifier] = context
    lock.unlock()
    existing?.cancel()

    DispatchQueue.global(qos: .utility).asyncAfter(
      deadline: .now() + request.timeoutMs / 1000,
      execute: timeoutWorkItem
    )
    task.resume()
    return promise
  }

  func cancel(requestId: String) {
    lock.lock()
    let task = activeTasks[requestId]
    lock.unlock()
    task?.cancel()
  }

  private func context(for task: URLSessionTask) -> LocalWebViewDownloadContext? {
    lock.lock()
    let context = contexts[task.taskIdentifier]
    lock.unlock()
    return context
  }

  private func failAndCancel(requestId: String, error: Error) {
    lock.lock()
    let task = activeTasks[requestId]
    if let task, let context = contexts[task.taskIdentifier], context.failure == nil {
      context.failure = error
    }
    lock.unlock()
    task?.cancel()
  }

  private func fail(_ context: LocalWebViewDownloadContext, with error: Error) {
    lock.lock()
    if context.failure == nil {
      context.failure = error
    }
    lock.unlock()
  }

  private func takeContext(for task: URLSessionTask) -> LocalWebViewDownloadContext? {
    lock.lock()
    let context = contexts.removeValue(forKey: task.taskIdentifier)
    if let context, activeTasks[context.requestId]?.taskIdentifier == task.taskIdentifier {
      activeTasks.removeValue(forKey: context.requestId)
    }
    context?.timeoutWorkItem?.cancel()
    lock.unlock()
    return context
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let context = context(for: dataTask) else {
      completionHandler(.cancel)
      return
    }
    guard let response = response as? HTTPURLResponse else {
      fail(context, with: LocalWebViewCacheError.nonHTTPResponse)
      completionHandler(.cancel)
      return
    }

    context.response = response
    let declaredBytes = response.expectedContentLength
    if let maximumBytes = context.maximumBytes,
      declaredBytes >= 0,
      declaredBytes > maximumBytes
    {
      fail(
        context,
        with: LocalWebViewCacheError.responseTooLarge(
          url: context.sourceUrl,
          maximum: maximumBytes,
          observed: declaredBytes
        )
      )
      completionHandler(.cancel)
      return
    }

    let writesFile = (200..<300).contains(response.statusCode)
    guard writesFile else {
      completionHandler(.allow)
      return
    }

    do {
      try ensureCacheParent(of: context.destination)
      guard FileManager.default.createFile(atPath: context.destination.path, contents: nil) else {
        throw CocoaError(.fileWriteUnknown)
      }
      context.fileHandle = try FileHandle(forWritingTo: context.destination)
      context.wroteFile = true
      completionHandler(.allow)
    } catch {
      fail(context, with: error)
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let context = context(for: dataTask) else {
      dataTask.cancel()
      return
    }
    let nextCount = context.receivedBytes + Int64(data.count)
    if let maximumBytes = context.maximumBytes, nextCount > maximumBytes {
      fail(
        context,
        with: LocalWebViewCacheError.responseTooLarge(
          url: context.sourceUrl,
          maximum: maximumBytes,
          observed: nextCount
        )
      )
      dataTask.cancel()
      return
    }

    context.receivedBytes = nextCount
    guard context.wroteFile else { return }
    do {
      context.pendingData.append(data)
      if context.pendingData.count >= downloadWriteBufferBytes {
        try context.flushPendingData()
      }
    } catch {
      fail(context, with: error)
      dataTask.cancel()
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let context = takeContext(for: task) else { return }
    var terminalError = context.failure ?? error
    if terminalError == nil {
      do {
        try context.flushPendingData()
      } catch {
        terminalError = error
      }
    }
    try? context.fileHandle?.close()
    context.fileHandle = nil

    if let terminalError {
      if context.wroteFile {
        try? FileManager.default.removeItem(at: context.destination)
      }
      context.promise.reject(withError: terminalError)
      return
    }

    guard let response = context.response else {
      if context.wroteFile {
        try? FileManager.default.removeItem(at: context.destination)
      }
      context.promise.reject(withError: LocalWebViewCacheError.nonHTTPResponse)
      return
    }

    do {
      var headers = [String: String]()
      for (key, value) in response.allHeaderFields {
        if let key = key as? String {
          headers[key] = String(describing: value)
        }
      }
      let result = LocalWebViewDownloadResponse(
        bytesWritten: context.wroteFile ? context.receivedBytes : 0,
        digests: context.wroteFile ? context.finalizeDigests() : nil,
        headers: headers,
        responseUrl: response.url?.absoluteString ?? context.sourceUrl,
        status: response.statusCode,
        wroteFile: context.wroteFile
      )
      let data = try JSONEncoder().encode(result)
      guard let json = String(data: data, encoding: .utf8) else {
        throw CocoaError(.fileReadInapplicableStringEncoding)
      }
      context.promise.resolve(withResult: json)
    } catch {
      if context.wroteFile {
        try? FileManager.default.removeItem(at: context.destination)
      }
      context.promise.reject(withError: error)
    }
  }
}

final class HybridLocalWebViewCache: HybridLocalWebViewCacheSpec {
  private let downloadClient = LocalWebViewDownloadClient()

  var documentsDirectory: String {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path
  }

  func cancelDownload(requestId: String) throws {
    downloadClient.cancel(requestId: requestId)
  }

  func copyFile(source: String, destination: String) throws -> Promise<Void> {
    Promise.parallel {
      let sourceUrl = cacheFileURL(source)
      let destinationUrl = cacheFileURL(destination)
      try ensureCacheParent(of: destinationUrl)
      try? FileManager.default.removeItem(at: destinationUrl)
      try FileManager.default.copyItem(at: sourceUrl, to: destinationUrl)
    }
  }

  func download(requestId: String, requestJson: String) throws -> Promise<String> {
    guard let requestData = requestJson.data(using: .utf8),
      let request = try? JSONDecoder().decode(LocalWebViewDownloadRequest.self, from: requestData),
      let url = URL(string: request.url),
      let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      request.timeoutMs > 0,
      request.maxBytes.map({ $0 >= 0 }) ?? true,
      Set(request.hashAlgorithms ?? []).isSubset(of: ["sha256", "sha384", "sha512"])
    else {
      return Promise.rejected(withError: LocalWebViewCacheError.invalidRequest)
    }

    return downloadClient.download(
      requestId: requestId,
      request: request,
      url: url
    )
  }

  func exists(path: String) throws -> Promise<Bool> {
    Promise.parallel {
      FileManager.default.fileExists(atPath: cacheFileURL(path).path)
    }
  }

  func hashFile(path: String, algorithmsJson: String) throws -> Promise<String> {
    Promise.parallel {
      guard let data = algorithmsJson.data(using: .utf8),
        let algorithms = try? JSONDecoder().decode([String].self, from: data)
      else {
        throw LocalWebViewCacheError.invalidRequest
      }
      let requested = Set(algorithms)
      guard requested.isSubset(of: ["sha256", "sha384", "sha512"]) else {
        throw LocalWebViewCacheError.invalidRequest
      }

      var sha256 = requested.contains("sha256") ? SHA256() : nil
      var sha384 = requested.contains("sha384") ? SHA384() : nil
      var sha512 = requested.contains("sha512") ? SHA512() : nil
      let handle = try FileHandle(forReadingFrom: cacheFileURL(path))
      defer { try? handle.close() }
      while true {
        let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
        if chunk.isEmpty { break }
        sha256?.update(data: chunk)
        sha384?.update(data: chunk)
        sha512?.update(data: chunk)
      }

      var result = [String: String]()
      if let digest = sha256?.finalize() { result["sha256"] = hexadecimal(digest) }
      if let digest = sha384?.finalize() { result["sha384"] = hexadecimal(digest) }
      if let digest = sha512?.finalize() { result["sha512"] = hexadecimal(digest) }
      let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
      guard let json = String(data: encoded, encoding: .utf8) else {
        throw CocoaError(.fileReadInapplicableStringEncoding)
      }
      return json
    }
  }

  func listDirectory(path: String) throws -> Promise<[String]> {
    Promise.parallel {
      try FileManager.default.contentsOfDirectory(atPath: cacheFileURL(path).path)
    }
  }

  func makeDirectory(path: String) throws -> Promise<Void> {
    Promise.parallel {
      try FileManager.default.createDirectory(
        at: cacheFileURL(path),
        withIntermediateDirectories: true
      )
    }
  }

  func moveFile(source: String, destination: String) throws -> Promise<Void> {
    Promise.parallel {
      let sourceUrl = cacheFileURL(source)
      let destinationUrl = cacheFileURL(destination)
      try ensureCacheParent(of: destinationUrl)
      try? FileManager.default.removeItem(at: destinationUrl)
      try FileManager.default.moveItem(at: sourceUrl, to: destinationUrl)
    }
  }

  func readFile(path: String, encoding: String) throws -> Promise<String> {
    Promise.parallel {
      let data = try Data(contentsOf: cacheFileURL(path), options: [.mappedIfSafe])
      return try Self.encode(data, as: encoding)
    }
  }

  func readFileRange(
    path: String,
    start: Double,
    end: Double,
    encoding: String
  ) throws -> Promise<String> {
    Promise.parallel {
      guard start.isFinite, end.isFinite, start >= 0, end >= start,
        start.rounded() == start, end.rounded() == end,
        end <= Double(Int64.max)
      else {
        throw LocalWebViewCacheError.invalidRange
      }
      let handle = try FileHandle(forReadingFrom: cacheFileURL(path))
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(start))
      let length = Int(end - start)
      let data = try handle.read(upToCount: length) ?? Data()
      guard data.count == length else { throw LocalWebViewCacheError.invalidRange }
      return try Self.encode(data, as: encoding)
    }
  }

  func remove(path: String) throws -> Promise<Void> {
    Promise.parallel {
      let url = cacheFileURL(path)
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }

  func stat(path: String) throws -> Promise<Double> {
    Promise.parallel {
      let attributes = try FileManager.default.attributesOfItem(atPath: cacheFileURL(path).path)
      guard let size = attributes[.size] as? NSNumber else {
        throw CocoaError(.fileReadUnknown)
      }
      return size.doubleValue
    }
  }

  func writeFile(
    path: String,
    value: String,
    encoding: String
  ) throws -> Promise<Void> {
    Promise.parallel {
      let data: Data
      switch encoding {
      case "base64":
        guard let decoded = Data(base64Encoded: value) else {
          throw LocalWebViewCacheError.invalidEncoding(encoding)
        }
        data = decoded
      case "utf8":
        data = Data(value.utf8)
      default:
        throw LocalWebViewCacheError.invalidEncoding(encoding)
      }
      let url = cacheFileURL(path)
      try ensureCacheParent(of: url)
      try data.write(to: url, options: [.atomic])
    }
  }

  private static func encode(_ data: Data, as encoding: String) throws -> String {
    switch encoding {
    case "base64":
      return data.base64EncodedString()
    case "utf8":
      guard let value = String(data: data, encoding: .utf8) else {
        throw CocoaError(.fileReadInapplicableStringEncoding)
      }
      return value
    default:
      throw LocalWebViewCacheError.invalidEncoding(encoding)
    }
  }
}
