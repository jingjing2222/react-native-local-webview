import NitroModules
import UIKit
import WebKit

private final class LocalWebViewContainer: UIView {
  weak var owner: LocalWebView?

  override func layoutSubviews() {
    super.layoutSubviews()
    subviews.first?.frame = bounds
    owner?.refreshContentInset()
  }
}

private final class LocalRuntimeWebView: WKWebView {
  var hasCustomMenuItems = false
  var suppressedMenuItems = Set<String>()

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if suppressedMenuItems.contains(Self.menuName(for: action)) {
      return false
    }
    if hasCustomMenuItems {
      return false
    }
    return super.canPerformAction(action, withSender: sender)
  }

  private static func menuName(for action: Selector) -> String {
    switch NSStringFromSelector(action) {
    case "cut:": "cut"
    case "copy:": "copy"
    case "paste:": "paste"
    case "delete:": "delete"
    case "select:": "select"
    case "selectAll:": "selectAll"
    case "_promptForReplace:": "replace"
    case "_define:": "lookup"
    case "_translate:": "translate"
    case "toggleBoldface:": "bold"
    case "toggleItalics:": "italic"
    case "toggleUnderline:": "underline"
    case "_share:": "share"
    default: NSStringFromSelector(action)
    }
  }
}

private final class LocalWebViewMessageProxy: NSObject, WKScriptMessageHandler {
  weak var owner: LocalWebView?

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    owner?.receive(message)
  }
}

private final class LocalWebViewRequestBodyProxy: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: LocalWebView?

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    owner?.receiveRequestBody(message.body, replyHandler: replyHandler)
      ?? replyHandler(nil, "The LocalWebView runtime is unavailable.")
  }
}

private final class LocalWebViewCookieStoreProxy: NSObject, WKHTTPCookieStoreObserver {
  weak var owner: LocalWebView?

  func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
    owner?.cookiesDidChange(in: cookieStore)
  }
}

private final class LocalWebViewMenuProxy: NSObject, UIEditMenuInteractionDelegate,
  UIGestureRecognizerDelegate
{
  weak var interaction: UIEditMenuInteraction?
  weak var owner: LocalWebView?

  @objc func presentMenu(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .ended, owner?.hasCustomMenuConfiguration == true else {
      return
    }
    interaction?.presentEditMenu(
      with: UIEditMenuConfiguration(
        identifier: nil,
        sourcePoint: recognizer.location(in: recognizer.view)
      )
    )
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard let owner else { return nil }
    return UIMenu(
      children: owner.customMenuItems.map { item in
        UIAction(title: item.label) { [weak owner] _ in
          owner?.selectCustomMenuItem(item)
        }
      }
    )
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

private final class LocalWebViewNavigationProxy: NSObject, WKNavigationDelegate {
  weak var owner: LocalWebView?

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    owner?.decidePolicy(for: navigationAction, decisionHandler: decisionHandler)
      ?? decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    owner?.decidePolicy(for: navigationResponse, decisionHandler: decisionHandler)
      ?? decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
    owner?.didStartNavigation()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
    owner?.didFinishNavigation()
  }

  func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation?,
    withError error: any Error
  ) {
    owner?.didFailNavigation(error, provisional: false)
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation?,
    withError error: any Error
  ) {
    owner?.didFailNavigation(error, provisional: true)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    owner?.emit("contentProcessDidTerminate")
  }

  func webView(
    _ webView: WKWebView,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (
      URLSession.AuthChallengeDisposition,
      URLCredential?
    ) -> Void
  ) {
    owner?.handle(challenge, completionHandler: completionHandler)
      ?? completionHandler(.performDefaultHandling, nil)
  }
}

private final class LocalWebViewUIProxy: NSObject, WKUIDelegate {
  weak var owner: LocalWebView?

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    owner?.openWindow(navigationAction)
    return nil
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    owner?.decideMediaCapturePermission(
      origin: origin,
      frame: frame,
      decisionHandler: decisionHandler
    ) ?? decisionHandler(.prompt)
  }

}

private final class LocalWebViewScrollProxy: NSObject, UIScrollViewDelegate {
  weak var owner: LocalWebView?

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    owner?.didScroll(scrollView)
  }
}

final class LocalWebView: HybridLocalWebViewSpec {
  fileprivate struct CustomMenuItem {
    let key: String
    let label: String
  }

  private static let messageHandlerName = "ReactNativeWebView"
  private static let historyHandlerName = "ReactNativeHistoryShim"
  private static let requestBodyHandlerName = "ReactNativeLocalWebViewRequestBody"
  private static let sharedProcessPool = WKProcessPool()
  private static let silentAudioDataUri = "data:audio/mp3;base64,//tAxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAAESAAzMzMzMzMzMzMzMzMzMzMzMzMzZmZmZmZmZmZmZmZmZmZmZmZmZmaZmZmZmZmZmZmZmZmZmZmZmZmZmczMzMzMzMzMzMzMzMzMzMzMzMzM//////////////////////////8AAAA5TEFNRTMuMTAwAZYAAAAAAAAAABQ4JAMGQgAAOAAABEhNIZS0AAAAAAD/+0DEAAPH3Yz0AAR8CPqyIEABp6AxjG/4x/XiInE4lfQDFwIIRE+uBgZoW4RL0OLMDFn6E5v+/u5ehf76bu7/6bu5+gAiIQGAABQIUJ0QolFghEn/9PhZQpcUTpXMjo0OGzRCZXyKxoIQzB2KhCtGobpT9TRVj/3Pmfp+f8X7Pu1B04sTnc3s0XhOlXoGVCMNo9X//9/r6a10TZEY5DsxqvO7mO5qFvpFCmKIjhpSItGsUYcRO//7QsQRgEiljQIAgLFJAbIhNBCa+JmorCbOi5q9nVd2dKnusTMQg4MFUlD6DQ4OFijwGAijRMfLbHG4nLVTjydyPlJTj8pfPflf9/5GD950A5e+jsrmNZSjSirjs1R7hnkia8vr//l/7Nb+crvr9Ok5ZJOylUKRxf/P9Zn0j2P4pJYXyKkeuy5wUYtdmOu6uobEtFqhIJViLEKIjGxchGev/L3Y0O3bwrIOszTBAZ7Ih28EUaSOZf/7QsQfg8fpjQIADN0JHbGgQBAZ8T//y//t/7d/2+f5m7MdCeo/9tdkMtGLbt1tqnabRroO1Qfvh20yEbei8nfDXP7btW7f9/uO9tbe5IvHQbLlxpf3DkAk0ojYcv///5/u3/7PTfGjPEPUvt5D6f+/3Lea4lz4tc4TnM/mFPrmalWbboeNiNyeyr+vufttZuvrVrt/WYv3T74JFo8qEDiJqJrmDTs///v99xDku2xG02jjunrICP/7QsQtA8kpkQAAgNMA/7FgQAGnobgfghgqA+uXwWQ3XFmGimSbe2X3ksY//KzK1a2k6cnNWOPJnPWUsYbKqkh8RJzrVf///P///////4vyhLKHLrCb5nIrYIUss4cthigL1lQ1wwNAc6C1pf1TIKRSkt+a//z+yLVcwlXKSqeSuCVQFLng2h4AFAFgTkH+Z/8jTX/zr//zsJV/5f//5UX/0ZNCNCCaf5lTCTRkaEdhNP//n/KUjf/7QsQ5AEhdiwAAjN7I6jGddBCO+WGTQ1mXrYatSAgaykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg=="

  private let container = LocalWebViewContainer()
  private let messageProxy = LocalWebViewMessageProxy()
  private let menuProxy = LocalWebViewMenuProxy()
  private let navigationProxy = LocalWebViewNavigationProxy()
  private let privateProtocolStatus = LocalAssetURLProtocol.install()
  private let protocolRegistryId = UUID().uuidString
  private let requestBodyProxy = LocalWebViewRequestBodyProxy()
  private let scrollProxy = LocalWebViewScrollProxy()
  private let uiProxy = LocalWebViewUIProxy()

  private var configuration = [String: Any]()
  private var configurationFingerprint = ""
  private var cookieStoreObserverInstalled = false
  private let cookieStoreProxy = LocalWebViewCookieStoreProxy()
  private var loadedDocumentId = ""
  private var lifecycleObservers = [NSObjectProtocol]()
  private var progressObservation: NSKeyValueObservation?
  private var protocolInstallationReleased = false
  private var refreshControl: UIRefreshControl?
  private var savedStatusBarHidden = false
  private var savedStatusBarStyle: UIStatusBarStyle = .default
  private var webView: WKWebView?

  let view: UIView

  var assetsJson = "[]"
  var baseUrl = ""
  var cacheRequestJson = ""
  var configurationJson = "{}"
  var documentId = ""
  var html = ""
  var sourceJson = ""
  var onEvent: (_ event: String) -> Void = { _ in }
  var onShouldStartLoadWithRequest: (_ request: String) -> Promise<Bool> = {
    _ in Promise.resolved(withResult: true)
  }

  override init() {
    view = container
    super.init()
    container.owner = self
    messageProxy.owner = self
    requestBodyProxy.owner = self
    cookieStoreProxy.owner = self
    menuProxy.owner = self
    navigationProxy.owner = self
    scrollProxy.owner = self
    uiProxy.owner = self
    savedStatusBarHidden = UIApplication.shared.isStatusBarHidden
    savedStatusBarStyle = UIApplication.shared.statusBarStyle
    lifecycleObservers = [
      NotificationCenter.default.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard self?.boolean("ignoreSilentHardwareSwitch", false) == true else { return }
        self?.startSilentAudio()
      },
      NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.stopSilentAudio()
      },
      NotificationCenter.default.addObserver(
        forName: UIWindow.didBecomeVisibleNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.showFullscreenVideoStatusBar()
      },
      NotificationCenter.default.addObserver(
        forName: UIWindow.didBecomeHiddenNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.restoreFullscreenVideoStatusBar()
      },
    ]
  }

  func afterUpdate() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.afterUpdate() }
      return
    }
    do {
      let nextConfiguration = try decodeObject(configurationJson)
      if webView == nil {
        configuration = nextConfiguration
        configurationFingerprint = configurationJson
        createWebView()
      } else if configurationFingerprint != configurationJson {
        configuration = nextConfiguration
        configurationFingerprint = configurationJson
        applyMutableConfiguration()
        installUserScripts()
      }
      guard !documentId.isEmpty, documentId != loadedDocumentId else { return }
      try loadDocument()
    } catch {
      emitRuntimeError(error.localizedDescription)
    }
  }

  func onDropView() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.onDropView() }
      return
    }
    progressObservation?.invalidate()
    progressObservation = nil
    stopSilentAudio()
    for observer in lifecycleObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    lifecycleObservers.removeAll()
    refreshControl?.removeFromSuperview()
    refreshControl = nil
    LocalAssetURLProtocol.unregister(registryId: protocolRegistryId)
    defer {
      if !protocolInstallationReleased {
        protocolInstallationReleased = true
        LocalAssetURLProtocol.releaseInstallation()
      }
    }
    guard let webView else { return }
    if cookieStoreObserverInstalled {
      webView.configuration.websiteDataStore.httpCookieStore.remove(cookieStoreProxy)
      cookieStoreObserverInstalled = false
    }
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.scrollView.delegate = nil
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: Self.messageHandlerName
    )
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: Self.historyHandlerName
    )
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: Self.requestBodyHandlerName
    )
    webView.configuration.userContentController.removeAllUserScripts()
    webView.removeFromSuperview()
    self.webView = nil
  }

  func clearCache(includeDiskFiles: Bool) throws {
    let memoryTypes: Set<String> = [
      WKWebsiteDataTypeMemoryCache,
      WKWebsiteDataTypeFetchCache,
      WKWebsiteDataTypeServiceWorkerRegistrations,
    ]
    let diskTypes: Set<String> = [
      WKWebsiteDataTypeDiskCache,
      WKWebsiteDataTypeOfflineWebApplicationCache,
      WKWebsiteDataTypeSessionStorage,
      WKWebsiteDataTypeLocalStorage,
      WKWebsiteDataTypeWebSQLDatabases,
      WKWebsiteDataTypeIndexedDBDatabases,
    ]
    let types = includeDiskFiles ? memoryTypes.union(diskTypes) : memoryTypes
    onMain { [weak self] in
      self?.webView?.configuration.websiteDataStore.removeData(
        ofTypes: types,
        modifiedSince: Date(timeIntervalSince1970: 0)
      ) {}
    }
  }

  func clearFormData() throws {
    // Android-only in react-native-webview.
  }

  func clearHistory() throws {
    // Android-only in react-native-webview.
  }

  func goBack() throws {
    onMain { [weak self] in self?.webView?.goBack() }
  }

  func goForward() throws {
    onMain { [weak self] in self?.webView?.goForward() }
  }

  func injectJavaScript(script: String) throws {
    onMain { [weak self] in self?.evaluate(script) }
  }

  func postMessage(message: String) throws {
    let encoded = try jsonString(message)
    onMain { [weak self] in
      self?.evaluate(
        "window.dispatchEvent(new MessageEvent('message',{data:\(encoded)}));true;"
      )
    }
  }

  func reload() throws {
    onMain { [weak self] in
      guard let self, let webView = self.webView else { return }
      if webView.url == nil {
        self.loadedDocumentId = ""
        do {
          try self.loadDocument()
        } catch {
          self.emitRuntimeError(error.localizedDescription)
        }
      } else {
        webView.reload()
      }
    }
  }

  func requestFocus() throws {
    onMain { [weak self] in self?.webView?.becomeFirstResponder() }
  }

  func stopLoading() throws {
    onMain { [weak self] in self?.webView?.stopLoading() }
  }

  private func onMain(_ operation: @escaping @MainActor @Sendable () -> Void) {
    Task { @MainActor in
      operation()
    }
  }

  private func createWebView() {
    let webViewConfiguration = WKWebViewConfiguration()
    let preferences = WKPreferences()
    preferences.javaScriptCanOpenWindowsAutomatically =
      boolean("javaScriptCanOpenWindowsAutomatically", false)
    preferences.isFraudulentWebsiteWarningEnabled =
      boolean("fraudulentWebsiteWarningEnabled", true)
    if boolean("allowFileAccessFromFileURLs", false) {
      preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
    }
    webViewConfiguration.preferences = preferences
    webViewConfiguration.defaultWebpagePreferences.allowsContentJavaScript =
      boolean("javaScriptEnabled", true)
    webViewConfiguration.allowsInlineMediaPlayback =
      boolean("allowsInlineMediaPlayback", false)
    webViewConfiguration.allowsPictureInPictureMediaPlayback =
      boolean("allowsPictureInPictureMediaPlayback", true)
    webViewConfiguration.allowsAirPlayForMediaPlayback =
      boolean("allowsAirPlayForMediaPlayback", false)
    webViewConfiguration.mediaTypesRequiringUserActionForPlayback =
      boolean("mediaPlaybackRequiresUserAction", true) ? .all : []
    webViewConfiguration.dataDetectorTypes = dataDetectorTypes()
    webViewConfiguration.websiteDataStore =
      boolean("incognito", false) || !boolean("cacheEnabled", true)
      ? .nonPersistent() : .default()
    if boolean("useSharedProcessPool", true) {
      webViewConfiguration.processPool = Self.sharedProcessPool
    }
    if let value = string("applicationNameForUserAgent") {
      webViewConfiguration.applicationNameForUserAgent = [
        webViewConfiguration.applicationNameForUserAgent,
        value,
      ].compactMap { $0 }.joined(separator: " ")
    }
    webViewConfiguration.defaultWebpagePreferences.preferredContentMode = contentMode()
    if boolean("limitsNavigationsToAppBoundDomains", false) {
      webViewConfiguration.limitsNavigationsToAppBoundDomains = true
    }
    if boolean("allowUniversalAccessFromFileURLs", false) {
      webViewConfiguration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")
    }
    webViewConfiguration.userContentController = WKUserContentController()

    let nextWebView = LocalRuntimeWebView(
      frame: container.bounds,
      configuration: webViewConfiguration
    )
    nextWebView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    nextWebView.isOpaque = false
    nextWebView.navigationDelegate = navigationProxy
    nextWebView.uiDelegate = uiProxy
    nextWebView.scrollView.delegate = scrollProxy
    container.addSubview(nextWebView)
    let menuInteraction = UIEditMenuInteraction(delegate: menuProxy)
    menuProxy.interaction = menuInteraction
    container.addInteraction(menuInteraction)
    let longPress = UILongPressGestureRecognizer(
      target: menuProxy,
      action: #selector(LocalWebViewMenuProxy.presentMenu(_:))
    )
    longPress.delegate = menuProxy
    container.addGestureRecognizer(longPress)
    webView = nextWebView
    applyMutableConfiguration()
    installUserScripts()
    observeProgress()
    synchronizeSharedCookies()
    configureCookieStoreObservation()
  }

  private func loadDocument() throws {
    guard let webView else { return }
    if !cacheRequestJson.isEmpty {
      let request = try decodeObject(cacheRequestJson)
      guard
        let requestedUrl = request["virtualUrl"] as? String,
        let remoteUrl = URL(string: requestedUrl)
      else {
        throw runtimeError("cacheRequestJson.virtualUrl must be a valid URL.")
      }
      if let cached = try LocalAssetURLProtocol.configureCachedBundle(
        cacheRequestJson: cacheRequestJson,
        basicAuthCredential: dictionary("basicAuthCredential"),
        cookieStore: webView.configuration.websiteDataStore.httpCookieStore,
        registryId: protocolRegistryId
      ) {
        guard let cachedUrl = URL(string: cached.baseUrl) else {
          throw runtimeError("The cached document URL is invalid.")
        }
        if cachedUrl.scheme == "https",
          !privateProtocolStatus.hasPrefix("Installed"),
          !privateProtocolStatus.hasSuffix("already installed.")
        {
          throw runtimeError(privateProtocolStatus)
        }
        baseUrl = cached.baseUrl
        loadedDocumentId = documentId
        webView.load(URLRequest(url: cachedUrl))
      } else {
        baseUrl = requestedUrl
        if dictionary("basicAuthCredential") == nil {
          LocalAssetURLProtocol.unregister(registryId: protocolRegistryId)
        } else {
          _ = try LocalAssetURLProtocol.configure(
            assetsJson: "[]",
            baseUrl: requestedUrl,
            basicAuthCredential: dictionary("basicAuthCredential"),
            cookieStore: webView.configuration.websiteDataStore.httpCookieStore,
            html: "",
            registryId: protocolRegistryId
          )
        }
        loadedDocumentId = documentId
        webView.load(URLRequest(url: remoteUrl))
      }
      return
    }
    if !sourceJson.isEmpty {
      let source = try decodeObject(sourceJson)
      guard let urlString = source["uri"] as? String, let url = URL(string: urlString) else {
        throw runtimeError("source.uri must be a valid URL.")
      }
      if dictionary("basicAuthCredential") == nil {
        // A direct source, including the first-install cache-miss path, must
        // stay on WKWebView's ordinary network stack. With no registry for
        // this view, the process-wide custom protocol declines these HTTPS
        // requests.
        LocalAssetURLProtocol.unregister(registryId: protocolRegistryId)
      } else {
        // The private protocol's URLSession delegate is still required for
        // React Native WebView-compatible HTTP Basic authentication.
        _ = try LocalAssetURLProtocol.configure(
          assetsJson: "[]",
          baseUrl: urlString,
          basicAuthCredential: dictionary("basicAuthCredential"),
          cookieStore: webView.configuration.websiteDataStore.httpCookieStore,
          html: "",
          registryId: protocolRegistryId
        )
      }
      var request = URLRequest(url: url)
      request.httpMethod = source["method"] as? String ?? "GET"
      if let headers = source["headers"] as? [String: Any] {
        for (name, value) in headers {
          request.setValue(String(describing: value), forHTTPHeaderField: name)
        }
      }
      if let body = source["body"] as? String {
        request.httpBody = Data(body.utf8)
      }
      loadedDocumentId = documentId
      if url.isFileURL {
        let readAccessUrl =
          string("allowingReadAccessToURL").flatMap(URL.init(string:)) ?? url
        webView.loadFileURL(url, allowingReadAccessTo: readAccessUrl)
      } else {
        webView.load(request)
      }
      return
    }
    guard let url = URL(string: baseUrl), url.scheme != nil else {
      throw runtimeError("source.baseUrl must be an absolute URL.")
    }
    let hasLocalEntry = try LocalAssetURLProtocol.configure(
      assetsJson: assetsJson,
      baseUrl: baseUrl,
      basicAuthCredential: dictionary("basicAuthCredential"),
      cookieStore: webView.configuration.websiteDataStore.httpCookieStore,
      html: html,
      registryId: protocolRegistryId
    )
    if url.scheme == "https",
      !privateProtocolStatus.hasPrefix("Installed"),
      !privateProtocolStatus.hasSuffix("already installed.")
    {
      throw runtimeError(privateProtocolStatus)
    }
    loadedDocumentId = documentId
    if hasLocalEntry {
      webView.load(URLRequest(url: url))
    } else {
      webView.loadHTMLString(html, baseURL: url)
    }
  }

  private func applyMutableConfiguration() {
    guard let webView else { return }
    let scrollView = webView.scrollView
    webView.allowsBackForwardNavigationGestures =
      boolean("allowsBackForwardNavigationGestures", false)
    webView.allowsLinkPreview = boolean("allowsLinkPreview", true)
    webView.customUserAgent = string("userAgent")
    webView.isInspectable = boolean("webviewDebuggingEnabled", false)
    webView.configuration.defaultWebpagePreferences.allowsContentJavaScript =
      boolean("javaScriptEnabled", true)
    scrollView.isScrollEnabled = boolean("scrollEnabled", true)
    scrollView.isPagingEnabled = boolean("pagingEnabled", false)
    scrollView.bounces =
      boolean("pullToRefreshEnabled", false) || boolean("bounces", true)
    scrollView.showsHorizontalScrollIndicator =
      boolean("showsHorizontalScrollIndicator", true)
    scrollView.showsVerticalScrollIndicator =
      boolean("showsVerticalScrollIndicator", true)
    scrollView.isDirectionalLockEnabled = boolean("directionalLockEnabled", true)
    scrollView.decelerationRate = decelerationRate()
    scrollView.indicatorStyle = indicatorStyle()
    refreshContentInset()
    scrollView.contentInsetAdjustmentBehavior = contentInsetAdjustmentBehavior()
    scrollView.automaticallyAdjustsScrollIndicatorInsets =
      boolean("automaticallyAdjustsScrollIndicatorInsets", false)
    webView.configuration.preferences.isTextInteractionEnabled =
      boolean("textInteractionEnabled", true)
    if let runtimeWebView = webView as? LocalRuntimeWebView {
      runtimeWebView.hasCustomMenuItems = hasCustomMenuConfiguration
      runtimeWebView.suppressedMenuItems = Set(
        configuration["suppressMenuItems"] as? [String] ?? []
      )
    }
    setPullToRefresh(boolean("pullToRefreshEnabled", false))
    applyKeyboardConfiguration()
    configureCookieStoreObservation()
    if boolean("ignoreSilentHardwareSwitch", false) {
      startSilentAudio()
    } else {
      stopSilentAudio()
    }
  }

  private func installUserScripts() {
    guard let webView else { return }
    let controller = webView.configuration.userContentController
    controller.removeAllUserScripts()
    controller.removeScriptMessageHandler(forName: Self.messageHandlerName)
    controller.removeScriptMessageHandler(forName: Self.historyHandlerName)
    controller.removeScriptMessageHandler(forName: Self.requestBodyHandlerName)
    if boolean("enableApplePay", false) {
      if boolean("messagingEnabled", false) {
        controller.add(messageProxy, name: Self.messageHandlerName)
      }
      return
    }

    controller.addScriptMessageHandler(
      requestBodyProxy,
      contentWorld: .page,
      name: Self.requestBodyHandlerName
    )
    controller.addUserScript(
      WKUserScript(
        source: requestBodyCaptureScript(),
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false
      )
    )

    controller.add(messageProxy, name: Self.historyHandlerName)
    controller.addUserScript(
      WKUserScript(
        source: """
          (function(history) {
            const channel = 'react-native-local-webview:history';
            function notify(type) {
              setTimeout(function() {
                let state = null;
                let stateSerializationFailed = false;
                try {
                  const serialized = JSON.stringify(history.state);
                  if (serialized === undefined) {
                    stateSerializationFailed = true;
                  } else {
                    state = JSON.parse(serialized);
                  }
                } catch {
                  stateSerializationFailed = true;
                }
                window.webkit.messageHandlers.\(Self.historyHandlerName).postMessage(
                  JSON.stringify({
                    channel,
                    length: history.length,
                    navigationType: type,
                    state,
                    stateSerializationFailed,
                    url: location.href
                  })
                );
              }, 0);
            }
            function shim(method, type) {
              return function() {
                const result = method.apply(history, arguments);
                notify(type);
                return result;
              };
            }
            history.pushState = shim(history.pushState, 'pushState');
            history.replaceState = shim(history.replaceState, 'replaceState');
            window.addEventListener('popstate', function() {
              notify('popstate');
            });
            window.addEventListener('hashchange', function() {
              notify('hashchange');
            });
            window.addEventListener('pageshow', function() {
              notify('pageshow');
            });
          })(window.history);
          """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      )
    )

    if boolean("messagingEnabled", false) {
      controller.add(messageProxy, name: Self.messageHandlerName)
      controller.addUserScript(
        WKUserScript(
          source: """
            (() => {
              const bridge = window.ReactNativeWebView || {};
              bridge.postMessage = value => window.webkit.messageHandlers.\(
                Self.messageHandlerName
              ).postMessage(String(value));
              Object.defineProperty(window, 'ReactNativeWebView', {
                configurable: true,
                value: bridge
              });
            })();
            """,
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
    }
    if let object = configuration["injectedJavaScriptObject"],
      let data = try? JSONSerialization.data(withJSONObject: object),
      let source = String(data: data, encoding: .utf8)
    {
      controller.addUserScript(
        WKUserScript(
          source: """
            window.ReactNativeWebView ||= {};
            window.ReactNativeWebView.injectedObjectJson = () => \(jsonStringUnchecked(source));
            """,
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
    }
    if let script = string("injectedJavaScriptBeforeContentLoaded") {
      controller.addUserScript(
        WKUserScript(
          source: script,
          injectionTime: .atDocumentStart,
          forMainFrameOnly: boolean(
            "injectedJavaScriptBeforeContentLoadedForMainFrameOnly",
            true
          )
        )
      )
    }
    if let script = string("injectedJavaScript") {
      controller.addUserScript(
        WKUserScript(
          source: script,
          injectionTime: .atDocumentEnd,
          forMainFrameOnly: boolean("injectedJavaScriptForMainFrameOnly", true)
        )
      )
    }
  }

  private func observeProgress() {
    progressObservation?.invalidate()
    progressObservation = webView?.observe(
      \.estimatedProgress,
      options: [.new]
    ) { [weak self] _, change in
      guard let self, let progress = change.newValue else { return }
      self.emit("loadProgress", extra: ["progress": progress])
    }
  }

  fileprivate func receive(_ message: WKScriptMessage) {
    if message.name == Self.historyHandlerName {
      let payload = message.body as? String ?? ""
      var navigationType = "other"
      if let data = payload.data(using: .utf8),
        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let type = value["navigationType"] as? String
      {
        navigationType = type
      }
      emit(
        "load",
        extra: ["navigationType": navigationType]
      )
      emit(
        "message",
        extra: [
          "data": payload,
          "url": message.frameInfo.request.url?.absoluteString ?? currentUrl,
        ]
      )
      return
    }
    emit(
      "message",
      extra: [
        "data": message.body as? String ?? String(describing: message.body),
        "url": message.frameInfo.request.url?.absoluteString ?? currentUrl,
      ]
    )
  }

  fileprivate func receiveRequestBody(
    _ message: Any,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    do {
      try LocalAssetURLProtocol.updateRequestBody(
        ownerId: protocolRegistryId,
        message: message
      )
      replyHandler(true, nil)
    } catch {
      replyHandler(nil, error.localizedDescription)
    }
  }

  fileprivate func decidePolicy(
    for action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let requestUrl = action.request.url?.absoluteString ?? ""
    let isTopFrame = action.request.url == action.request.mainDocumentURL
    let hasTargetFrame = action.targetFrame != nil
    if !hasTargetFrame {
      if boolean("hasOnOpenWindow", false) {
        emit("openWindow", extra: ["targetUrl": requestUrl])
      } else {
        webView?.load(action.request)
      }
      decisionHandler(.cancel)
      return
    }
    guard originAllowed(requestUrl) else {
      if let url = action.request.url {
        UIApplication.shared.open(url)
      }
      decisionHandler(.cancel)
      return
    }
    guard boolean("hasOnShouldStartLoadWithRequest", false) else {
      decisionHandler(.allow)
      return
    }
    var request = baseEvent()
    request["url"] = requestUrl
    request["mainDocumentURL"] = action.request.mainDocumentURL?.absoluteString
    request["navigationType"] = navigationType(action.navigationType)
    request["isTopFrame"] = isTopFrame
    request["hasTargetFrame"] = hasTargetFrame
    request["lockIdentifier"] = 0
    guard let serialized = encodeJson(request) else {
      decisionHandler(.cancel)
      return
    }
    let promise = onShouldStartLoadWithRequest(serialized)
    promise.then { allowed in
      DispatchQueue.main.async {
        decisionHandler(allowed ? .allow : .cancel)
      }
    }.catch { [weak self] error in
      DispatchQueue.main.async {
        self?.emitRuntimeError(error.localizedDescription)
        decisionHandler(.cancel)
      }
    }
  }

  fileprivate func decidePolicy(
    for response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    guard let httpResponse = response.response as? HTTPURLResponse else {
      decisionHandler(.allow)
      return
    }
    if response.isForMainFrame, httpResponse.statusCode >= 400 {
      emit(
        "httpError",
        extra: [
          "statusCode": httpResponse.statusCode,
          "url": httpResponse.url?.absoluteString ?? currentUrl,
        ]
      )
    }
    let disposition = httpResponse.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    if boolean("hasOnFileDownload", false),
      disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType
    {
      emit(
        "fileDownload",
        extra: ["downloadUrl": httpResponse.url?.absoluteString ?? currentUrl]
      )
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  fileprivate func didStartNavigation() {
    emit("loadStart")
  }

  fileprivate func didFinishNavigation() {
    synchronizeCookiesBack()
    if boolean("ignoreSilentHardwareSwitch", false) {
      startSilentAudio()
    }
    emit("load")
  }

  fileprivate func didFailNavigation(_ error: any Error, provisional: Bool) {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
      return
    }
    emit(
      "error",
      extra: [
        "code": nsError.code,
        "description": nsError.localizedDescription,
        "didFailProvisionalNavigation": provisional,
        "domain": nsError.domain,
      ]
    )
  }

  fileprivate func handle(
    _ challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (
      URLSession.AuthChallengeDisposition,
      URLCredential?
    ) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodHTTPBasic,
      let credential = dictionary("basicAuthCredential"),
      let username = credential["username"] as? String,
      let password = credential["password"] as? String
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    completionHandler(
      .useCredential,
      URLCredential(user: username, password: password, persistence: .none)
    )
  }

  fileprivate func openWindow(_ action: WKNavigationAction) {
    let targetUrl = action.request.url?.absoluteString ?? ""
    emit("openWindow", extra: ["targetUrl": targetUrl])
  }

  fileprivate func decideMediaCapturePermission(
    origin: WKSecurityOrigin,
    frame: WKFrameInfo,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    let mode = string("mediaCapturePermissionGrantType")
      ?? "prompt"
    switch mode {
    case "grant":
      decisionHandler(.grant)
    case "deny":
      decisionHandler(.deny)
    case "prompt":
      decisionHandler(.prompt)
    case "grantIfSameHostElseDeny":
      decisionHandler(origin.host == webView?.url?.host ? .grant : .deny)
    default:
      decisionHandler(origin.host == webView?.url?.host ? .grant : .prompt)
    }
  }


  fileprivate func didScroll(_ scrollView: UIScrollView) {
    guard boolean("hasOnScroll", false) else { return }
    emit(
      "scroll",
      extra: [
        "contentInset": [
          "bottom": Double(scrollView.contentInset.bottom),
          "left": Double(scrollView.contentInset.left),
          "right": Double(scrollView.contentInset.right),
          "top": Double(scrollView.contentInset.top),
        ],
        "contentOffset": pointDictionary(
          x: scrollView.contentOffset.x,
          y: scrollView.contentOffset.y
        ),
        "contentSize": pointDictionary(
          x: scrollView.contentSize.width,
          y: scrollView.contentSize.height
        ),
        "layoutMeasurement": pointDictionary(
          x: scrollView.bounds.width,
          y: scrollView.bounds.height
        ),
        "velocity": pointDictionary(
          x: scrollView.panGestureRecognizer.velocity(in: scrollView).x,
          y: scrollView.panGestureRecognizer.velocity(in: scrollView).y
        ),
        "zoomScale": scrollView.zoomScale,
      ]
    )
  }

  fileprivate func refreshContentInset() {
    guard let scrollView = webView?.scrollView else { return }
    var inset = edgeInsets("contentInset")
    if boolean("automaticallyAdjustContentInsets", true) {
      let safeArea = container.safeAreaInsets
      inset.top += safeArea.top
      inset.left += safeArea.left
      inset.bottom += safeArea.bottom
      inset.right += safeArea.right
    }
    if scrollView.contentInset != inset {
      scrollView.contentInset = inset
    }
    scrollView.scrollIndicatorInsets = inset
  }

  fileprivate var hasCustomMenuConfiguration: Bool {
    configuration.keys.contains("menuItems")
  }

  fileprivate var customMenuItems: [CustomMenuItem] {
    guard let values = configuration["menuItems"] as? [[String: Any]] else {
      return []
    }
    return values.compactMap { value in
      guard
        let key = value["key"] as? String,
        let label = value["label"] as? String
      else {
        return nil
      }
      return CustomMenuItem(key: key, label: label)
    }
  }

  fileprivate func selectCustomMenuItem(_ item: CustomMenuItem) {
    webView?.evaluateJavaScript("window.getSelection().toString()") {
      [weak self] selectedText, error in
      if let error {
        self?.emitRuntimeError(error.localizedDescription)
        return
      }
      self?.emit(
        "customMenuSelection",
        extra: [
          "key": item.key,
          "label": item.label,
          "selectedText": selectedText as? String ?? "",
        ]
      )
    }
  }

  @objc private func refresh(_ sender: UIRefreshControl) {
    webView?.reload()
    sender.endRefreshing()
  }

  private func setPullToRefresh(_ enabled: Bool) {
    guard let webView else { return }
    if enabled, refreshControl == nil {
      let control = UIRefreshControl()
      control.overrideUserInterfaceStyle =
        boolean("refreshControlLightMode", false) ? .light : .unspecified
      control.addTarget(self, action: #selector(refresh(_:)), for: .valueChanged)
      webView.scrollView.addSubview(control)
      refreshControl = control
    } else if !enabled {
      refreshControl?.removeFromSuperview()
      refreshControl = nil
    }
  }

  private func startSilentAudio() {
    webView?.evaluateJavaScript(
      """
      (() => {
        document.getElementById('wkwebviewAudio')?.remove();
        const audio = new Audio('\(Self.silentAudioDataUri)');
        audio.id = 'wkwebviewAudio';
        audio.controls = false;
        audio.loop = true;
        (document.body || document.documentElement).appendChild(audio);
        audio.play().catch(() => {});
        return true;
      })();
      """
    )
  }

  private func stopSilentAudio() {
    webView?.evaluateJavaScript(
      """
      (() => {
        const audio = document.getElementById('wkwebviewAudio');
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.remove();
        }
        return true;
      })();
      """
    )
  }

  private func showFullscreenVideoStatusBar() {
    guard boolean("autoManageStatusBarEnabled", true) else { return }
    UIApplication.shared.setStatusBarStyle(savedStatusBarStyle, animated: true)
  }

  private func restoreFullscreenVideoStatusBar() {
    guard boolean("autoManageStatusBarEnabled", true) else { return }
    UIApplication.shared.setStatusBarHidden(savedStatusBarHidden, with: .fade)
    UIApplication.shared.setStatusBarStyle(savedStatusBarStyle, animated: true)
  }

  private func applyKeyboardConfiguration() {
    guard let webView else { return }
    LocalWebViewKeyboardWorkarounds.configureWebView(
      webView,
      hideKeyboardAccessoryView: boolean("hideKeyboardAccessoryView", false),
      keyboardDisplayRequiresUserAction: boolean(
        "keyboardDisplayRequiresUserAction",
        true
      )
    )
  }

  private func synchronizeSharedCookies() {
    guard boolean("sharedCookiesEnabled", false), let webView else { return }
    for cookie in HTTPCookieStorage.shared.cookies ?? [] {
      webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
    }
  }

  private func configureCookieStoreObservation() {
    guard let webView else { return }
    let shouldObserve = boolean("sharedCookiesEnabled", false)
    if shouldObserve, !cookieStoreObserverInstalled {
      webView.configuration.websiteDataStore.httpCookieStore.add(cookieStoreProxy)
      cookieStoreObserverInstalled = true
    } else if !shouldObserve, cookieStoreObserverInstalled {
      webView.configuration.websiteDataStore.httpCookieStore.remove(cookieStoreProxy)
      cookieStoreObserverInstalled = false
    }
  }

  fileprivate func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
    guard boolean("sharedCookiesEnabled", false) else { return }
    cookieStore.getAllCookies { cookies in
      for cookie in cookies {
        HTTPCookieStorage.shared.setCookie(cookie)
      }
    }
  }

  private func synchronizeCookiesBack() {
    guard boolean("sharedCookiesEnabled", false), let webView else { return }
    webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
      for cookie in cookies {
        HTTPCookieStorage.shared.setCookie(cookie)
      }
    }
  }

  private func evaluate(_ source: String) {
    guard !boolean("enableApplePay", false) else {
      emitRuntimeError("JavaScript evaluation is unavailable while enableApplePay is true.")
      return
    }
    webView?.evaluateJavaScript(source) { [weak self] _, error in
      if let error {
        self?.emitRuntimeError(error.localizedDescription)
      }
    }
  }

  fileprivate func emit(
    _ type: String,
    extra: [String: Any] = [:]
  ) {
    var nativeEvent = baseEvent()
    for (key, value) in extra {
      nativeEvent[key] = value
    }
    guard
      let serialized = encodeJson([
        "nativeEvent": nativeEvent,
        "type": type,
      ])
    else {
      return
    }
    onEvent(serialized)
  }

  private func emitRuntimeError(_ description: String) {
    emit("runtimeError", extra: ["description": description])
  }

  private func baseEvent() -> [String: Any] {
    [
      "canGoBack": webView?.canGoBack ?? false,
      "canGoForward": webView?.canGoForward ?? false,
      "loading": webView?.isLoading ?? false,
      "lockIdentifier": 0,
      "target": 0,
      "title": webView?.title ?? "",
      "url": currentUrl,
    ]
  }

  private var currentUrl: String {
    webView?.url?.absoluteString ?? baseUrl
  }

  private func boolean(_ key: String, _ fallback: Bool) -> Bool {
    configuration[key] as? Bool ?? fallback
  }

  private func string(_ key: String) -> String? {
    configuration[key] as? String
  }

  private func dictionary(_ key: String) -> [String: Any]? {
    configuration[key] as? [String: Any]
  }

  private func decelerationRate() -> UIScrollView.DecelerationRate {
    if let value = configuration["decelerationRate"] as? Double {
      return .init(rawValue: value)
    }
    return string("decelerationRate") == "fast" ? .fast : .normal
  }

  private func indicatorStyle() -> UIScrollView.IndicatorStyle {
    switch string("indicatorStyle") {
    case "black": .black
    case "white": .white
    default: .default
    }
  }

  private func contentMode() -> WKWebpagePreferences.ContentMode {
    switch string("contentMode") {
    case "mobile": .mobile
    case "desktop": .desktop
    default: .recommended
    }
  }

  private func contentInsetAdjustmentBehavior() -> UIScrollView.ContentInsetAdjustmentBehavior {
    switch string("contentInsetAdjustmentBehavior") {
    case "automatic": .automatic
    case "scrollableAxes": .scrollableAxes
    case "always": .always
    case "never": .never
    default: .never
    }
  }

  private func edgeInsets(_ key: String) -> UIEdgeInsets {
    guard let value = dictionary(key) else { return .zero }
    return UIEdgeInsets(
      top: value["top"] as? Double ?? 0,
      left: value["left"] as? Double ?? 0,
      bottom: value["bottom"] as? Double ?? 0,
      right: value["right"] as? Double ?? 0
    )
  }

  private func dataDetectorTypes() -> WKDataDetectorTypes {
    guard let values = configuration["dataDetectorTypes"] as? [String] else {
      return []
    }
    if values.contains("all") {
      return .all
    }
    var result: WKDataDetectorTypes = []
    for value in values {
      switch value {
      case "phoneNumber": result.insert(.phoneNumber)
      case "link": result.insert(.link)
      case "address": result.insert(.address)
      case "calendarEvent": result.insert(.calendarEvent)
      case "trackingNumber": result.insert(.trackingNumber)
      case "flightNumber": result.insert(.flightNumber)
      case "lookupSuggestion": result.insert(.lookupSuggestion)
      default: break
      }
    }
    return result
  }

  private func navigationType(_ type: WKNavigationType) -> String {
    switch type {
    case .linkActivated: "click"
    case .formSubmitted: "formsubmit"
    case .backForward: "backforward"
    case .reload: "reload"
    case .formResubmitted: "formresubmit"
    default: "other"
    }
  }

  private func requestBodyCaptureScript() -> String {
    """
    (() => {
      if (globalThis.__REACT_NATIVE_LOCAL_WEBVIEW_BODY_CAPTURE__) return;
      const bridge = globalThis.webkit?.messageHandlers?.\(Self.requestBodyHandlerName);
      if (!bridge || typeof globalThis.fetch !== 'function') return;
      Object.defineProperty(globalThis, '__REACT_NATIVE_LOCAL_WEBVIEW_BODY_CAPTURE__', {
        configurable: false,
        value: true
      });
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const tokenHeader = \(jsonStringUnchecked(LocalAssetURLProtocol.requestBodyTokenHeader));
      const encode = bytes => {
        let result = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        }
        return btoa(result);
      };
      const token = () => {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        const values = new Uint32Array(4);
        globalThis.crypto?.getRandomValues?.(values);
        return Array.from(values, value => value.toString(16).padStart(8, '0')).join('-');
      };
      const capture = async request => {
        const requestUrl = new URL(request.url);
        if (
          requestUrl.protocol !== 'https:' ||
          requestUrl.origin !== globalThis.location.origin ||
          request.method === 'GET' ||
          request.method === 'HEAD' ||
          request.body === null
        ) {
          return request;
        }
        const id = token();
        await bridge.postMessage({ start: true, token: id });
        try {
          const reader = request.clone().body.getReader();
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            await bridge.postMessage({
              chunk: encode(result.value),
              token: id
            });
          }
          await bridge.postMessage({ complete: true, token: id });
          const headers = new Headers(request.headers);
          headers.set(tokenHeader, id);
          return new Request(request, { headers });
        } catch (error) {
          await bridge.postMessage({ cancel: true, token: id }).catch(() => {});
          throw error;
        }
      };
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        return nativeFetch(await capture(request));
      };
      const NativeXMLHttpRequest = globalThis.XMLHttpRequest;
      if (NativeXMLHttpRequest) {
        const states = new WeakMap();
        const nativeAbort = NativeXMLHttpRequest.prototype.abort;
        const nativeOpen = NativeXMLHttpRequest.prototype.open;
        const nativeSend = NativeXMLHttpRequest.prototype.send;
        const nativeSetRequestHeader = NativeXMLHttpRequest.prototype.setRequestHeader;
        NativeXMLHttpRequest.prototype.open = function(method, url, async = true) {
          const result = nativeOpen.apply(this, arguments);
          states.set(this, {
            aborted: false,
            async: async !== false,
            headers: new Headers(),
            method: String(method).toUpperCase(),
            url: new URL(String(url), globalThis.location.href).href
          });
          return result;
        };
        NativeXMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          const result = nativeSetRequestHeader.apply(this, arguments);
          states.get(this)?.headers.append(String(name), String(value));
          return result;
        };
        NativeXMLHttpRequest.prototype.abort = function() {
          const state = states.get(this);
          if (state) state.aborted = true;
          return nativeAbort.apply(this, arguments);
        };
        NativeXMLHttpRequest.prototype.send = function(body) {
          const xhr = this;
          const state = states.get(xhr);
          if (
            !state ||
            !state.async ||
            body == null ||
            state.url.slice(0, 8).toLowerCase() !== 'https://' ||
            state.method === 'GET' ||
            state.method === 'HEAD'
          ) {
            return nativeSend.apply(xhr, arguments);
          }
          Promise.resolve().then(async () => {
            const request = new Request(state.url, {
              body,
              headers: state.headers,
              method: state.method
            });
            const captured = await capture(request);
            if (states.get(xhr) !== state || state.aborted) return;
            const token = captured.headers.get(tokenHeader);
            if (!token) throw new Error('Failed to capture the XMLHttpRequest body.');
            const contentType = request.headers.get('Content-Type');
            if (contentType && !state.headers.has('Content-Type')) {
              nativeSetRequestHeader.call(xhr, 'Content-Type', contentType);
            }
            nativeSetRequestHeader.call(xhr, tokenHeader, token);
            nativeSend.call(xhr, body);
          }).catch(() => {
            if (states.get(xhr) === state && !state.aborted) {
              nativeSend.call(xhr, body);
            }
          });
          return undefined;
        };
      }
    })();
    """
  }

  private func originAllowed(_ url: String) -> Bool {
    let origin: String
    if let match = url.range(
      of: #"^[A-Za-z][A-Za-z0-9+\-.]+:(//)?[^/]*"#,
      options: .regularExpression
    ) {
      origin = String(url[match])
    } else {
      origin = ""
    }
    let configured = configuration["originWhitelist"] as? [String]
      ?? ["http://*", "https://*"]
    return (["about:blank"] + configured).contains { pattern in
      let expression = "^" + NSRegularExpression
        .escapedPattern(for: pattern)
        .replacingOccurrences(of: "\\*", with: ".*") + "$"
      return origin.range(of: expression, options: .regularExpression) != nil
    }
  }

  private func pointDictionary(x: CGFloat, y: CGFloat) -> [String: Double] {
    ["height": Double(y), "width": Double(x), "x": Double(x), "y": Double(y)]
  }

}

private func decodeObject(_ source: String) throws -> [String: Any] {
  guard
    let value = try JSONSerialization.jsonObject(with: Data(source.utf8)) as? [String: Any]
  else {
    throw runtimeError("configurationJson must contain a JSON object.")
  }
  return value
}

private func encodeJson(_ value: Any) -> String? {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value)
  else {
    return nil
  }
  return String(data: data, encoding: .utf8)
}

private func jsonString(_ value: String) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: [value])
  guard
    var source = String(data: data, encoding: .utf8),
    source.count >= 2
  else {
    throw runtimeError("Unable to JSON-encode a string.")
  }
  source.removeFirst()
  source.removeLast()
  return source
}

private func jsonStringUnchecked(_ value: String) -> String {
  (try? jsonString(value)) ?? "\"\""
}

private func runtimeError(_ message: String) -> NSError {
  NSError(
    domain: "ReactNativeLocalWebView",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
