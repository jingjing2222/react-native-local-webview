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
  let headers: [String: String]?
  let maxBytes: Int64?
  let path: String
  let timeoutMs: Double
  let url: String
}

private struct LocalWebViewDownloadResponse: Encodable {
  let headers: [String: String]
  let responseUrl: String
  let status: Int
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

private final class LocalWebViewDownloadDelegate: NSObject, URLSessionDataDelegate {
  private weak var owner: HybridLocalWebViewCache?
  private let destination: URL
  private var failure: Error?
  private var fileHandle: FileHandle?
  private let maximumBytes: Int64?
  private let promise: Promise<String>
  private var receivedBytes: Int64 = 0
  private var response: HTTPURLResponse?
  private let requestId: String
  private let sourceUrl: String

  init(
    owner: HybridLocalWebViewCache,
    destination: URL,
    maximumBytes: Int64?,
    promise: Promise<String>,
    requestId: String,
    sourceUrl: String
  ) {
    self.owner = owner
    self.destination = destination
    self.maximumBytes = maximumBytes
    self.promise = promise
    self.requestId = requestId
    self.sourceUrl = sourceUrl
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
    guard let response = response as? HTTPURLResponse else {
      failure = LocalWebViewCacheError.nonHTTPResponse
      completionHandler(.cancel)
      return
    }

    self.response = response
    let declaredBytes = response.expectedContentLength
    if let maximumBytes, declaredBytes >= 0, declaredBytes > maximumBytes {
      failure = LocalWebViewCacheError.responseTooLarge(
        url: sourceUrl,
        maximum: maximumBytes,
        observed: declaredBytes
      )
      completionHandler(.cancel)
      return
    }

    do {
      try ensureCacheParent(of: destination)
      try? FileManager.default.removeItem(at: destination)
      guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
        throw CocoaError(.fileWriteUnknown)
      }
      fileHandle = try FileHandle(forWritingTo: destination)
      completionHandler(.allow)
    } catch {
      failure = error
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let nextCount = receivedBytes + Int64(data.count)
    if let maximumBytes, nextCount > maximumBytes {
      failure = LocalWebViewCacheError.responseTooLarge(
        url: sourceUrl,
        maximum: maximumBytes,
        observed: nextCount
      )
      dataTask.cancel()
      return
    }

    do {
      try fileHandle?.write(contentsOf: data)
      receivedBytes = nextCount
    } catch {
      failure = error
      dataTask.cancel()
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    try? fileHandle?.close()
    fileHandle = nil
    owner?.finishDownload(requestId)
    session.finishTasksAndInvalidate()

    if let terminalError = failure ?? error {
      try? FileManager.default.removeItem(at: destination)
      promise.reject(withError: terminalError)
      return
    }

    guard let response else {
      try? FileManager.default.removeItem(at: destination)
      promise.reject(withError: LocalWebViewCacheError.nonHTTPResponse)
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
        headers: headers,
        responseUrl: response.url?.absoluteString ?? sourceUrl,
        status: response.statusCode
      )
      let data = try JSONEncoder().encode(result)
      guard let json = String(data: data, encoding: .utf8) else {
        throw CocoaError(.fileReadInapplicableStringEncoding)
      }
      promise.resolve(withResult: json)
    } catch {
      try? FileManager.default.removeItem(at: destination)
      promise.reject(withError: error)
    }
  }
}

final class HybridLocalWebViewCache: HybridLocalWebViewCacheSpec {
  private struct ActiveDownload {
    let session: URLSession
    let task: URLSessionDataTask
  }

  private var activeDownloads = [String: ActiveDownload]()
  private let downloadLock = NSLock()

  var documentsDirectory: String {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path
  }

  func cancelDownload(requestId: String) throws {
    downloadLock.lock()
    let download = activeDownloads[requestId]
    downloadLock.unlock()
    download?.task.cancel()
    download?.session.invalidateAndCancel()
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
      request.maxBytes.map({ $0 >= 0 }) ?? true
    else {
      return Promise.rejected(withError: LocalWebViewCacheError.invalidRequest)
    }

    let promise = Promise<String>()
    let delegate = LocalWebViewDownloadDelegate(
      owner: self,
      destination: cacheFileURL(request.path),
      maximumBytes: request.maxBytes,
      promise: promise,
      requestId: requestId,
      sourceUrl: request.url
    )
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = request.timeoutMs / 1000
    configuration.timeoutIntervalForResource = request.timeoutMs / 1000
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = "GET"
    urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
    urlRequest.timeoutInterval = request.timeoutMs / 1000
    urlRequest.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.headers?.forEach { urlRequest.setValue($0.value, forHTTPHeaderField: $0.key) }
    let task = session.dataTask(with: urlRequest)

    downloadLock.lock()
    if let existing = activeDownloads.updateValue(
      ActiveDownload(session: session, task: task),
      forKey: requestId
    ) {
      existing.task.cancel()
      existing.session.invalidateAndCancel()
    }
    downloadLock.unlock()
    task.resume()
    return promise
  }

  fileprivate func finishDownload(_ requestId: String) {
    downloadLock.lock()
    activeDownloads.removeValue(forKey: requestId)
    downloadLock.unlock()
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
