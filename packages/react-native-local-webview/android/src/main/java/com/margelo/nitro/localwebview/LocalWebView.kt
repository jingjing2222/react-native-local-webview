package com.margelo.nitro.localwebview

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Message
import android.view.View
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.facebook.react.uimanager.ThemedReactContext
import com.margelo.nitro.core.Promise
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

private data class LocalAsset(
  val mediaType: String,
  val path: String,
  val responseHeaders: Map<String, String>,
  val size: Long,
)

private data class CachedDocument(
  val baseUrl: String,
  val html: String,
  val streamEntryFromFile: Boolean,
)

private data class ByteRange(
  val start: Long,
  val endExclusive: Long,
)

private class BoundedFileInputStream(
  file: File,
  private var remaining: Long,
) : InputStream() {
  private val input = FileInputStream(file)

  override fun available(): Int = minOf(input.available().toLong(), remaining).toInt()

  override fun read(): Int {
    if (remaining <= 0) return -1
    val value = input.read()
    if (value >= 0) remaining -= 1
    return value
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (remaining <= 0) return -1
    val count = input.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
    if (count > 0) remaining -= count.toLong()
    return count
  }

  override fun skip(count: Long): Long {
    val skipped = input.skip(minOf(count, remaining))
    remaining -= skipped
    return skipped
  }

  override fun close() = input.close()
}

private class LocalRuntimeWebView(
  context: android.content.Context,
  private val owner: LocalWebView,
) : WebView(context) {
  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    owner.contentSizeChanged(width, height)
  }

  override fun onScrollChanged(left: Int, top: Int, oldLeft: Int, oldTop: Int) {
    super.onScrollChanged(left, top, oldLeft, oldTop)
    owner.didScroll(left, top, oldLeft, oldTop)
  }
}

private class LocalJavaScriptBridge(
  private val owner: LocalWebView,
) {
  @JavascriptInterface
  fun postMessage(message: String) {
    owner.dispatchMessage(message)
  }
}

private class LocalRuntimeWebViewClient(
  private val owner: LocalWebView,
) : WebViewClient() {
  override fun shouldInterceptRequest(
    view: WebView,
    request: WebResourceRequest,
  ): WebResourceResponse? = owner.intercept(request)

  override fun shouldOverrideUrlLoading(
    view: WebView,
    request: WebResourceRequest,
  ): Boolean = owner.shouldOverride(request)

  override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
    owner.pageStarted(url)
  }

  override fun onPageFinished(view: WebView, url: String?) {
    owner.pageFinished(url)
  }

  override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
    super.doUpdateVisitedHistory(view, url, isReload)
    owner.visitedHistoryUpdated(url)
  }

  override fun onReceivedError(
    view: WebView,
    request: WebResourceRequest,
    error: WebResourceError,
  ) {
    owner.receivedError(request, error)
  }

  override fun onReceivedHttpError(
    view: WebView,
    request: WebResourceRequest,
    errorResponse: WebResourceResponse,
  ) {
    owner.receivedHttpError(request, errorResponse)
  }

  override fun onRenderProcessGone(
    view: WebView,
    detail: RenderProcessGoneDetail,
  ): Boolean {
    owner.emit(
      "renderProcessGone",
      mapOf(
        "didCrash" to detail.didCrash(),
        "rendererPriorityAtExit" to detail.rendererPriorityAtExit(),
      ),
    )
    return true
  }

  override fun onReceivedHttpAuthRequest(
    view: WebView,
    handler: HttpAuthHandler,
    host: String,
    realm: String,
  ) {
    val credential = owner.configuration.optJSONObject("basicAuthCredential")
    if (
      credential != null &&
        credential.has("username") &&
        credential.has("password")
    ) {
      handler.proceed(credential.getString("username"), credential.getString("password"))
    } else {
      super.onReceivedHttpAuthRequest(view, handler, host, realm)
    }
  }
}

private class LocalRuntimeChromeClient(
  private val owner: LocalWebView,
) : WebChromeClient() {
  override fun onProgressChanged(view: WebView, newProgress: Int) {
    owner.emit("loadProgress", mapOf("progress" to newProgress / 100.0))
  }

  override fun onCreateWindow(
    view: WebView,
    isDialog: Boolean,
    isUserGesture: Boolean,
    resultMsg: Message,
  ): Boolean {
    val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
    val temporary = WebView(view.context)
    temporary.webViewClient =
      object : WebViewClient() {
        override fun shouldOverrideUrlLoading(
          child: WebView,
          request: WebResourceRequest,
        ): Boolean {
          owner.openWindow(request.url.toString())
          child.destroy()
          return true
        }
      }
    transport.webView = temporary
    resultMsg.sendToTarget()
    return true
  }

  override fun onGeolocationPermissionsShowPrompt(
    origin: String,
    callback: GeolocationPermissions.Callback,
  ) {
    owner.requestGeolocationPermission(origin, callback)
  }

  override fun onPermissionRequest(request: PermissionRequest) {
    owner.requestWebPermissions(request)
  }

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    if (!owner.configuration.optBoolean("allowsFullscreenVideo", false)) {
      callback.onCustomViewHidden()
      return
    }
    owner.showFullscreen(view, callback)
  }

  override fun onHideCustomView() {
    owner.hideFullscreen()
  }

  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<Uri>>,
    fileChooserParams: FileChooserParams,
  ): Boolean = owner.showFileChooser(filePathCallback, fileChooserParams)
}

@SuppressLint("SetJavaScriptEnabled")
class LocalWebView(
  private val context: ThemedReactContext,
) : HybridLocalWebViewSpec() {
  private val container = FrameLayout(context)
  private val webView = LocalRuntimeWebView(context, this)
  private val assets = mutableMapOf<String, LocalAsset>()
  private var loadedDocumentId = ""
  private var mainFrameLoadFailed = false
  private var cacheMiss = false
  private var streamEntryFromFile = false
  private var messagingEnabled = false
  private var usesWebMessageListener = false
  private var documentStartScriptHandler: ScriptHandler? = null
  private var usesNativeDocumentStartScript = false
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
  private var fullscreenView: View? = null
  private var filePathCallback: ValueCallback<Array<Uri>>? = null
  private var geolocationPermissionCallback: GeolocationPermissions.Callback? = null
  private var geolocationPermissionOrigin: String? = null
  private var pendingDownloadPermissionMessage: String? = null
  private var pendingDownloadRequest: DownloadManager.Request? = null
  private var pendingDownloadingMessage: String? = null
  private val grantedWebResources = linkedSetOf<String>()
  private val pendingAndroidPermissions = linkedSetOf<String>()
  private val pendingWebPermissions = linkedSetOf<String>()
  private var permissionRequestInFlight = false
  private var webPermissionRequest: PermissionRequest? = null
  private val permissionListener =
    PermissionListener { requestCode, permissions, grantResults ->
      if (requestCode != PERMISSION_REQUEST_CODE) return@PermissionListener false
      for (index in permissions.indices) {
        val permission = permissions[index]
        val granted = grantResults.getOrNull(index) == PackageManager.PERMISSION_GRANTED
        if (
          permission == Manifest.permission.ACCESS_FINE_LOCATION &&
            geolocationPermissionCallback != null
        ) {
          geolocationPermissionCallback?.invoke(
            geolocationPermissionOrigin.orEmpty(),
            granted,
            false,
          )
          geolocationPermissionCallback = null
          geolocationPermissionOrigin = null
        }
        if (permission == Manifest.permission.WRITE_EXTERNAL_STORAGE) {
          val downloadRequest = pendingDownloadRequest
          val downloadingMessage = pendingDownloadingMessage
          val permissionMessage = pendingDownloadPermissionMessage
          pendingDownloadRequest = null
          pendingDownloadingMessage = null
          pendingDownloadPermissionMessage = null
          if (granted && downloadRequest != null && downloadingMessage != null) {
            enqueueDownload(downloadRequest, downloadingMessage)
          } else if (permissionMessage != null) {
            Toast.makeText(context, permissionMessage, Toast.LENGTH_LONG).show()
          }
        }
        val webResource =
          when (permission) {
            Manifest.permission.RECORD_AUDIO -> PermissionRequest.RESOURCE_AUDIO_CAPTURE
            Manifest.permission.CAMERA -> PermissionRequest.RESOURCE_VIDEO_CAPTURE
            else -> null
          }
        if (webResource != null) {
          pendingWebPermissions.remove(permission)
          if (granted) grantedWebResources.add(webResource)
        }
      }
      permissionRequestInFlight = false
      if (pendingWebPermissions.isEmpty()) {
        webPermissionRequest?.grant(grantedWebResources.toTypedArray())
        webPermissionRequest = null
        grantedWebResources.clear()
      }
      requestQueuedAndroidPermissions()
      true
    }
  private val activityEventListener: ActivityEventListener =
    object : BaseActivityEventListener() {
      override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
      ) {
        if (requestCode != FILE_CHOOSER_REQUEST_CODE) return
        val callback = filePathCallback ?: return
        filePathCallback = null
        callback.onReceiveValue(
          WebChromeClient.FileChooserParams.parseResult(resultCode, data),
        )
      }
    }

  override val view: View = container

  override var assetsJson = "[]"
  override var baseUrl = ""
  override var cacheRequestJson = ""
  override var configurationJson = "{}"
  override var documentId = ""
  override var html = ""
  override var sourceJson = ""
  override var onEvent: (event: String) -> Unit = {}
  override var onShouldStartLoadWithRequest: (request: String) -> Promise<Boolean> = {
    Promise.resolved(true)
  }

  internal var configuration = JSONObject()
    private set

  init {
    webView.layoutParams =
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
    webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
    webView.webViewClient = LocalRuntimeWebViewClient(this)
    webView.webChromeClient = LocalRuntimeChromeClient(this)
    webView.setDownloadListener { url, userAgent, contentDisposition, mediaType, _ ->
      download(url, userAgent, contentDisposition, mediaType)
    }
    context.addActivityEventListener(activityEventListener)
    container.addView(webView)
  }

  override fun afterUpdate() {
    webView.post {
      try {
        configuration = JSONObject(configurationJson)
        applyConfiguration()
        if (documentId.isNotEmpty() && documentId != loadedDocumentId) {
          loadedDocumentId = documentId
          cacheMiss = false
          streamEntryFromFile = false
          if (cacheRequestJson.isNotEmpty()) {
            val request = JSONObject(cacheRequestJson)
            val cached = configureCachedAssets(request)
            if (cached == null) {
              assets.clear()
              cacheMiss = true
              baseUrl = request.getString("virtualUrl")
              webView.loadUrl(baseUrl)
            } else {
              baseUrl = cached.baseUrl
              html = cached.html
              streamEntryFromFile = cached.streamEntryFromFile
              webView.loadUrl(baseUrl)
            }
          } else if (sourceJson.isEmpty()) {
            configureAssets()
            if (assets.containsKey(normalize(baseUrl))) {
              webView.loadUrl(baseUrl)
            } else {
              webView.loadDataWithBaseURL(
                baseUrl,
                htmlWithBootstrap(),
                "text/html",
                "UTF-8",
                null,
              )
            }
          } else {
            loadDirectSource()
          }
        }
      } catch (error: Throwable) {
        emitRuntimeError(error.message ?: error.toString())
      }
    }
  }

  override fun onDropView() {
    webView.post {
      hideFullscreen()
      webView.stopLoading()
      filePathCallback?.onReceiveValue(null)
      filePathCallback = null
      webPermissionRequest?.deny()
      webPermissionRequest = null
      geolocationPermissionCallback?.invoke(
        geolocationPermissionOrigin.orEmpty(),
        false,
        false,
      )
      geolocationPermissionCallback = null
      geolocationPermissionOrigin = null
      pendingDownloadRequest = null
      pendingDownloadingMessage = null
      pendingDownloadPermissionMessage = null
      context.removeActivityEventListener(activityEventListener)
      removeMessagingBridge()
      documentStartScriptHandler?.remove()
      documentStartScriptHandler = null
      usesNativeDocumentStartScript = false
      webView.webChromeClient = null
      webView.webViewClient = WebViewClient()
      webView.loadUrl("about:blank")
      webView.clearHistory()
      webView.removeAllViews()
      container.removeAllViews()
      webView.destroy()
    }
  }

  override fun clearCache(includeDiskFiles: Boolean) {
    webView.post { webView.clearCache(includeDiskFiles) }
  }

  override fun clearFormData() {
    webView.post { webView.clearFormData() }
  }

  override fun clearHistory() {
    webView.post { webView.clearHistory() }
  }

  override fun goBack() {
    webView.post { if (webView.canGoBack()) webView.goBack() }
  }

  override fun goForward() {
    webView.post { if (webView.canGoForward()) webView.goForward() }
  }

  override fun injectJavaScript(script: String) {
    webView.post { webView.evaluateJavascript(script, null) }
  }

  override fun postMessage(message: String) {
    val encoded = JSONObject.quote(message)
    webView.post {
      webView.evaluateJavascript(
        "window.dispatchEvent(new MessageEvent('message',{data:$encoded}));true;",
        null,
      )
    }
  }

  override fun reload() {
    webView.post {
      if (webView.url == null) {
        loadedDocumentId = ""
        afterUpdate()
      } else {
        webView.reload()
      }
    }
  }

  override fun requestFocus() {
    webView.post { webView.requestFocus() }
  }

  override fun stopLoading() {
    webView.post { webView.stopLoading() }
  }

  @Suppress("DEPRECATION")
  private fun applyConfiguration() {
    val settings = webView.settings
    settings.javaScriptEnabled = configuration.optBoolean("javaScriptEnabled", true)
    settings.javaScriptCanOpenWindowsAutomatically =
      configuration.optBoolean("javaScriptCanOpenWindowsAutomatically", false)
    settings.mediaPlaybackRequiresUserGesture =
      configuration.optBoolean("mediaPlaybackRequiresUserAction", true)
    settings.domStorageEnabled = configuration.optBoolean("domStorageEnabled", true)
    settings.allowFileAccess = configuration.optBoolean("allowFileAccess", false)
    settings.allowContentAccess = false
    settings.allowFileAccessFromFileURLs =
      configuration.optBoolean("allowFileAccessFromFileURLs", false)
    settings.allowUniversalAccessFromFileURLs =
      configuration.optBoolean("allowUniversalAccessFromFileURLs", false)
    settings.saveFormData = !configuration.optBoolean("saveFormDataDisabled", false)
    settings.setSupportMultipleWindows(
      configuration.optBoolean("setSupportMultipleWindows", true),
    )
    settings.builtInZoomControls =
      configuration.optBoolean("setBuiltInZoomControls", true)
    settings.displayZoomControls =
      configuration.optBoolean("setDisplayZoomControls", false)
    settings.loadWithOverviewMode = configuration.optBoolean("scalesPageToFit", true)
    settings.useWideViewPort = configuration.optBoolean("scalesPageToFit", true)
    settings.textZoom = configuration.optInt("textZoom", 100)
    settings.minimumFontSize = configuration.optInt("minimumFontSize", 8)
    settings.setGeolocationEnabled(configuration.optBoolean("geolocationEnabled", false))
    settings.cacheMode =
      when (configuration.optString("cacheMode", "LOAD_DEFAULT")) {
        "LOAD_CACHE_ONLY" -> WebSettings.LOAD_CACHE_ONLY
        "LOAD_CACHE_ELSE_NETWORK" -> WebSettings.LOAD_CACHE_ELSE_NETWORK
        "LOAD_NO_CACHE" -> WebSettings.LOAD_NO_CACHE
        else ->
          if (configuration.optBoolean("cacheEnabled", true)) {
            WebSettings.LOAD_DEFAULT
          } else {
            WebSettings.LOAD_NO_CACHE
          }
      }
    settings.mixedContentMode =
      when (configuration.optString("mixedContentMode", "never")) {
        "always" -> WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        "compatibility" -> WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        else -> WebSettings.MIXED_CONTENT_NEVER_ALLOW
      }
    val applicationName = configuration.optNullableString("applicationNameForUserAgent")
    settings.userAgentString =
      configuration.optNullableString("userAgent")
        ?: if (applicationName == null) {
          WebSettings.getDefaultUserAgent(context)
        } else {
          "${WebSettings.getDefaultUserAgent(context)} $applicationName"
        }
    webView.isHorizontalScrollBarEnabled =
      configuration.optBoolean("showsHorizontalScrollIndicator", true)
    webView.isVerticalScrollBarEnabled =
      configuration.optBoolean("showsVerticalScrollIndicator", true)
    webView.isNestedScrollingEnabled = configuration.optBoolean("nestedScrollEnabled", false)
    webView.overScrollMode =
      when (configuration.optString("overScrollMode", "always")) {
        "never" -> View.OVER_SCROLL_NEVER
        "content" -> View.OVER_SCROLL_IF_CONTENT_SCROLLS
        else -> View.OVER_SCROLL_ALWAYS
      }
    webView.setLayerType(
      when (configuration.optString("androidLayerType", "none")) {
        "hardware" -> View.LAYER_TYPE_HARDWARE
        "software" -> View.LAYER_TYPE_SOFTWARE
        else -> View.LAYER_TYPE_NONE
      },
      null,
    )
    CookieManager.getInstance().setAcceptThirdPartyCookies(
      webView,
      configuration.optBoolean("thirdPartyCookiesEnabled", true),
    )
    WebView.setWebContentsDebuggingEnabled(
      configuration.optBoolean("webviewDebuggingEnabled", false),
    )
    val shouldEnableMessaging = configuration.optBoolean("messagingEnabled", false)
    if (shouldEnableMessaging != messagingEnabled) {
      if (shouldEnableMessaging) {
        installMessagingBridge()
      } else {
        removeMessagingBridge()
      }
      messagingEnabled = shouldEnableMessaging
    }
    configureDocumentStartScript()
    applyAndroidXSettings(settings)
  }

  private fun configureDocumentStartScript() {
    documentStartScriptHandler?.remove()
    documentStartScriptHandler = null
    usesNativeDocumentStartScript = false
    if (cacheRequestJson.isEmpty()) return
    val script = configuration.optNullableString("documentStartScript")
    if (script.isNullOrEmpty()) return
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    try {
      documentStartScriptHandler =
        WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
      usesNativeDocumentStartScript = true
    } catch (_: UnsupportedOperationException) {
      // AndroidX and the installed WebView can be updated independently.
      // Preserve the HTML-injection fallback if feature negotiation races it.
    }
  }

  @Suppress("DEPRECATION")
  private fun applyAndroidXSettings(settings: WebSettings) {
    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
        WebSettingsCompat.setForceDark(
          settings,
          if (configuration.optBoolean("forceDarkOn", false)) {
            WebSettingsCompat.FORCE_DARK_ON
          } else {
            WebSettingsCompat.FORCE_DARK_OFF
          },
        )
      }
      if (
        configuration.optBoolean("forceDarkOn", false) &&
          WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK_STRATEGY)
      ) {
        WebSettingsCompat.setForceDarkStrategy(
          settings,
          WebSettingsCompat.DARK_STRATEGY_PREFER_WEB_THEME_OVER_USER_AGENT_DARKENING,
        )
      }
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.PAYMENT_REQUEST)) {
      WebSettingsCompat.setPaymentRequestEnabled(
        settings,
        configuration.optBoolean("paymentRequestEnabled", false),
      )
    }
  }

  private fun installMessagingBridge() {
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(
        webView,
        BRIDGE_NAME,
        setOf("*"),
        object : WebViewCompat.WebMessageListener {
          override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
          ) {
            message.data?.let { data ->
              dispatchMessage(data, sourceOrigin.toString())
            }
          }
        },
      )
      usesWebMessageListener = true
    } else {
      webView.addJavascriptInterface(LocalJavaScriptBridge(this), BRIDGE_NAME)
      usesWebMessageListener = false
    }
  }

  private fun removeMessagingBridge() {
    if (usesWebMessageListener) {
      WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME)
    } else {
      webView.removeJavascriptInterface(BRIDGE_NAME)
    }
    usesWebMessageListener = false
  }

  private fun configureAssets() {
    assets.clear()
    val array = JSONArray(assetsJson)
    for (index in 0 until array.length()) {
      val value = array.getJSONObject(index)
      val descriptor =
        LocalAsset(
          mediaType = value.getString("mediaType"),
          path = value.getString("path"),
          responseHeaders =
            value.optJSONObject("responseHeaders")?.toStringMap().orEmpty(),
          size = value.getLong("size"),
        )
      assets[normalize(value.getString("originalUrl"))] = descriptor
      assets[normalize(value.getString("responseUrl"))] = descriptor
    }
  }

  private fun configureCachedAssets(request: JSONObject): CachedDocument? {
    val cachePath = request.getString("cacheDirectory")
    val cacheDirectory =
      if (cachePath.startsWith("file://")) File(URI(cachePath)) else File(cachePath)
    val virtualUrl = request.getString("virtualUrl")
    val expectedFingerprint = request.getString("securityPolicyFingerprint")
    val expectedValidationMode = request.getString("validationMode")
    val maxBytes = request.getLong("maxBytes")
    val requestedGenerationId = request.optNullableString("generationId")
    if (
      !virtualUrl.startsWith("https://") ||
        !FINGERPRINT_PATTERN.matches(expectedFingerprint) ||
        maxBytes <= 0
    ) {
      return null
    }
    val state =
      readJsonObject(File(cacheDirectory, "state.json"))
        ?.takeIf(::validCacheState)
        ?: readJsonObject(File(cacheDirectory, "state.previous.json"))
          ?.takeIf(::validCacheState)
        ?: return null
    val summaries = state.getJSONArray("generations")
    val ordered = mutableListOf<String>()
    if (requestedGenerationId != null) {
      ordered.add(requestedGenerationId)
    } else {
      ordered.add(state.getString("activeGeneration"))
      for (index in 0 until summaries.length()) {
        val generationId = summaries.getJSONObject(index).getString("generationId")
        if (generationId !in ordered) ordered.add(generationId)
      }
    }
    for (generationId in ordered) {
      if (!GENERATION_ID_PATTERN.matches(generationId)) continue
      val summary =
        (0 until summaries.length())
          .map { summaries.getJSONObject(it) }
          .firstOrNull { it.optString("generationId") == generationId }
          ?: continue
      val totalBytes = summary.optLong("totalBytes", -1)
      if (
        summary.optString("securityPolicyFingerprint") != expectedFingerprint ||
          totalBytes < 0 ||
          totalBytes > maxBytes
      ) {
        continue
      }
      val generationDirectory = File(File(cacheDirectory, "generations"), generationId)
      val manifest =
        readJsonObject(File(generationDirectory, "manifest.json")) ?: continue
      if (
        manifest.optInt("formatVersion") != CACHE_FORMAT_VERSION ||
          manifest.optString("generationId") != generationId ||
          manifest.optString("securityPolicyFingerprint") != expectedFingerprint ||
          manifest.optString("validationMode") != expectedValidationMode ||
          manifest.optLong("totalBytes", -1) != totalBytes ||
          normalize(manifest.optString("entryUrl")) != normalize(virtualUrl) ||
          (expectedValidationMode == "release-etag" &&
            manifest.optString("bundleEtag").isEmpty())
      ) {
        continue
      }
      val source = File(generationDirectory, "index.html")
      if (!source.isFile) continue
      val nextAssets = mutableMapOf<String, LocalAsset>()
      val remoteAssets = manifest.optJSONArray("remoteAssets") ?: continue
      var valid = true
      for (index in 0 until remoteAssets.length()) {
        val value = remoteAssets.optJSONObject(index)
        if (value == null) {
          valid = false
          break
        }
        if (value.optString("delivery") != "file") continue
        val sha256 = value.optString("sha256")
        val localFile = value.optString("localFile")
        val originalUrl = value.optString("url")
        val responseUrl = value.optString("responseUrl")
        val size = value.optLong("size", -1)
        if (
          !FINGERPRINT_PATTERN.matches(sha256) ||
            localFile != "assets/$sha256" ||
            !originalUrl.startsWith("https://") ||
            !responseUrl.startsWith("https://") ||
            size < 0
        ) {
          valid = false
          break
        }
        val descriptor =
          LocalAsset(
            mediaType = value.optString("mediaType", "application/octet-stream"),
            path = File(generationDirectory, localFile).absolutePath,
            responseHeaders =
              value.optJSONObject("responseHeaders")?.toStringMap().orEmpty(),
            size = size,
          )
        nextAssets[normalize(originalUrl)] = descriptor
        nextAssets[normalize(responseUrl)] = descriptor
      }
      if (!valid) continue
      val documentUrl = manifest.optString("documentUrl")
      if (!documentUrl.startsWith("https://")) continue
      val inherited = manifest.optBoolean("documentFragmentInherited")
      val fragment =
        if (inherited) Uri.parse(virtualUrl).encodedFragment
        else manifest.optString("documentFragment").removePrefix("#").ifEmpty { null }
      val runtimeUrl = Uri.parse(documentUrl).buildUpon().encodedFragment(fragment).build().toString()
      val canStreamEntry =
        usesNativeDocumentStartScript ||
          configuration.optNullableString("documentStartScript").isNullOrEmpty()
      val sourceHtml =
        if (canStreamEntry) "" else prepareCachedHtml(source.readText(Charsets.UTF_8))
      nextAssets[normalize(runtimeUrl)] =
        LocalAsset(
          mediaType = "text/html",
          path = source.absolutePath,
          responseHeaders = emptyMap(),
          size =
            if (canStreamEntry) source.length()
            else sourceHtml.toByteArray(Charsets.UTF_8).size.toLong(),
        )
      assets.clear()
      assets.putAll(nextAssets)
      return CachedDocument(
        baseUrl = runtimeUrl,
        html = sourceHtml,
        streamEntryFromFile = canStreamEntry,
      )
    }
    return null
  }

  private fun prepareCachedHtml(source: String): String {
    val script = configuration.optNullableString("documentStartScript") ?: return source
    if (script.isEmpty()) return source
    val head = Regex("<head(?:\\s[^>]*)?>", RegexOption.IGNORE_CASE).find(source)
      ?: error("Cached HTML document does not contain a <head>.")
    val bootstrap =
      "<script data-local-webview-bootstrap>${script.escapeScriptRawText()}</script>"
    return source.replaceRange(head.range.last + 1, head.range.last + 1, bootstrap)
  }

  private fun readJsonObject(file: File): JSONObject? =
    try {
      if (file.isFile) JSONObject(file.readText(Charsets.UTF_8)) else null
    } catch (_: Throwable) {
      null
    }

  private fun validCacheState(state: JSONObject): Boolean {
    if (state.optInt("formatVersion") != CACHE_FORMAT_VERSION) return false
    val active = state.optString("activeGeneration")
    if (!GENERATION_ID_PATTERN.matches(active)) return false
    val generations = state.optJSONArray("generations") ?: return false
    for (index in 0 until generations.length()) {
      val summary = generations.optJSONObject(index) ?: return false
      if (
        !GENERATION_ID_PATTERN.matches(summary.optString("generationId")) ||
          !FINGERPRINT_PATTERN.matches(summary.optString("securityPolicyFingerprint")) ||
          summary.optLong("totalBytes", -1) < 0
      ) {
        return false
      }
    }
    return (0 until generations.length()).any {
      generations.getJSONObject(it).optString("generationId") == active
    }
  }

  private fun loadDirectSource() {
    val source = JSONObject(sourceJson)
    val uri = source.getString("uri")
    if (source.optString("method", "GET").equals("POST", ignoreCase = true)) {
      webView.postUrl(uri, source.optString("body", "").toByteArray(Charsets.UTF_8))
      return
    }
    val headers = mutableMapOf<String, String>()
    source.optJSONObject("headers")?.let { values ->
      for (name in values.keys()) {
        val value = values.getString(name)
        if (name.equals("user-agent", ignoreCase = true)) {
          webView.settings.userAgentString = value
        } else {
          headers[name] = value
        }
      }
    }
    webView.loadUrl(uri, headers)
  }

  internal fun intercept(request: WebResourceRequest): WebResourceResponse? {
    if (request.method != "GET" && request.method != "HEAD") return null
    val asset = assets[normalize(request.url.toString())] ?: return null
    return try {
      val isEntry = normalize(request.url.toString()) == normalize(baseUrl)
      val entryBytes =
        if (isEntry && !streamEntryFromFile) {
          htmlWithBootstrap().toByteArray(Charsets.UTF_8)
        } else {
          null
        }
      val file = if (entryBytes == null) File(asset.path) else null
      val actualSize = entryBytes?.size?.toLong() ?: checkNotNull(file).length()
      if (file != null) {
        check(actualSize == asset.size) {
          "Local asset size mismatch for ${request.url}: expected ${asset.size}, found $actualSize."
        }
      }
      val rangeHeader =
        request.requestHeaders.entries
          .firstOrNull { (name) -> name.equals("Range", ignoreCase = true) }
          ?.value
      val range = parseRange(rangeHeader, actualSize)
      if (range == null) {
        WebResourceResponse(
          asset.mediaType,
          null,
          416,
          "Range Not Satisfiable",
          mapOf(
            "Accept-Ranges" to "bytes",
            "Content-Range" to "bytes */$actualSize",
            "Content-Length" to "0",
          ),
          ByteArrayInputStream(ByteArray(0)),
        )
      } else {
        val partial = !rangeHeader.isNullOrBlank()
        val length = range.endExclusive - range.start
        val headers =
          asset.responseHeaders.toMutableMap().apply {
            put("Accept-Ranges", "bytes")
            put("Cache-Control", "no-store")
            put("Content-Length", length.toString())
            put("X-Content-Type-Options", "nosniff")
          }
        if (partial) {
          headers["Content-Range"] =
            "bytes ${range.start}-${range.endExclusive - 1}/$actualSize"
        }
        WebResourceResponse(
          asset.mediaType,
          null,
          if (partial) 206 else 200,
          if (partial) "Partial Content" else "OK",
          headers,
          if (request.method == "HEAD") {
            ByteArrayInputStream(ByteArray(0))
          } else if (entryBytes != null) {
            // Chromium applies the original request's byte range to an intercepted
            // InputStream, but reads until EOF. Expose [0, end) so its seek leaves
            // exactly [start, end) instead of skipping twice or reading past end.
            ByteArrayInputStream(entryBytes, 0, range.endExclusive.toInt())
          } else {
            BoundedFileInputStream(checkNotNull(file), range.endExclusive)
          },
        )
      }
    } catch (error: Throwable) {
      webView.post { emitRuntimeError(error.message ?: error.toString()) }
      val message = (error.message ?: error.toString()).toByteArray(Charsets.UTF_8)
      WebResourceResponse(
        "text/plain",
        "UTF-8",
        500,
        "Local Asset Error",
        mapOf(
          "Cache-Control" to "no-store",
          "Content-Length" to message.size.toString(),
        ),
        ByteArrayInputStream(message),
      )
    }
  }

  internal fun shouldOverride(request: WebResourceRequest): Boolean {
    if (!request.isForMainFrame) return false
    val url = request.url.toString()
    if (!originAllowed(url)) {
      openExternalUrl(url)
      return true
    }
    if (!configuration.optBoolean("hasOnShouldStartLoadWithRequest", false)) {
      return false
    }
    val event =
      baseEvent().apply {
        put("url", url)
        put("mainDocumentURL", url)
        put("navigationType", "other")
        put("isTopFrame", request.isForMainFrame)
        put("hasTargetFrame", true)
        put("lockIdentifier", 0)
      }
    val shouldAllow = AtomicBoolean(true)
    val completed = CountDownLatch(1)
    onShouldStartLoadWithRequest(event.toString())
      .then { result ->
        shouldAllow.set(result)
        completed.countDown()
      }.catch { error ->
        webView.post { emitRuntimeError(error.message ?: error.toString()) }
        completed.countDown()
      }
    return try {
      if (!completed.await(SHOULD_START_TIMEOUT_MILLISECONDS, TimeUnit.MILLISECONDS)) {
        false
      } else {
        !shouldAllow.get()
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    }
  }

  internal fun openWindow(url: String) {
    if (configuration.optBoolean("hasOnOpenWindow", false)) {
      emit("openWindow", mapOf("targetUrl" to url))
    } else {
      webView.post { webView.loadUrl(url) }
    }
  }

  internal fun pageFinished(url: String?) {
    if (mainFrameLoadFailed) return
    configuration.optNullableString("injectedJavaScript")?.let {
      webView.evaluateJavascript("(() => {$it;})();", null)
    }
    injectJavaScriptObject()
    emit("load", mapOf("url" to (url ?: baseUrl)))
    contentSizeChanged(webView.width, webView.height)
  }

  internal fun pageStarted(url: String?) {
    mainFrameLoadFailed = false
    // Mirrored/static HTML embeds this script through parse5 before the first
    // page script. Direct network sources cannot be rewritten, so retain the
    // react-native-webview onPageStarted fallback for those requests.
    if (
      !usesNativeDocumentStartScript &&
        (sourceJson.isNotEmpty() ||
          cacheMiss ||
          configuration.optBoolean("isDirectHtmlSource", false))
    ) {
      val beforeScript =
        configuration.optNullableString("injectedJavaScriptBeforeContentLoaded").orEmpty()
      val objectScript = javaScriptObjectSource()
      if (beforeScript.isNotEmpty() || objectScript.isNotEmpty()) {
        webView.evaluateJavascript(
          """
          (() => {
            $beforeScript
            $objectScript
          })();
          """.trimIndent(),
          null,
        )
      }
    }
    emit("loadStart", mapOf("url" to (url ?: baseUrl)))
  }

  internal fun visitedHistoryUpdated(url: String?) {
    emit("loadStart", mapOf("url" to (url ?: baseUrl)))
  }

  internal fun receivedError(
    request: WebResourceRequest,
    error: WebResourceError,
  ) {
    if (request.isForMainFrame) mainFrameLoadFailed = true
    val values =
      mapOf(
        "code" to error.errorCode,
        "description" to error.description.toString(),
        "domain" to "AndroidWebView",
        "url" to request.url.toString(),
      )
    emit(if (request.isForMainFrame) "error" else "loadSubResourceError", values)
  }

  internal fun receivedHttpError(
    request: WebResourceRequest,
    response: WebResourceResponse,
  ) {
    if (!request.isForMainFrame || response.statusCode < 400) return
    emit(
      "httpError",
      mapOf(
        "description" to response.reasonPhrase,
        "statusCode" to response.statusCode,
        "url" to request.url.toString(),
      ),
    )
  }

  internal fun dispatchMessage(
    message: String,
    sourceUrl: String? = null,
  ) {
    if (
      !message.startsWith(HISTORY_MESSAGE_PREFIX) &&
        !configuration.optBoolean("hasOnMessage", false)
    ) {
      return
    }
    webView.post {
      emit(
        "message",
        mapOf(
          "data" to message,
          "url" to (sourceUrl ?: webView.url ?: baseUrl),
        ),
      )
    }
  }

  internal fun didScroll(left: Int, top: Int, oldLeft: Int, oldTop: Int) {
    if (!configuration.optBoolean("hasOnScroll", false)) return
    emit(
      "scroll",
      mapOf(
        "contentInset" to
          JSONObject()
            .put("bottom", 0)
            .put("left", 0)
            .put("right", 0)
            .put("top", 0),
        "contentOffset" to point(left, top),
        "contentSize" to
          point(
            (webView.width / webView.scale.coerceAtLeast(0.01f)).toInt(),
            webView.contentHeight,
          ),
        "layoutMeasurement" to point(webView.width, webView.height),
        "velocity" to point(left - oldLeft, top - oldTop),
        "zoomScale" to webView.scale,
      ),
    )
  }

  internal fun contentSizeChanged(width: Int, height: Int) {
    if (!configuration.optBoolean("hasOnContentSizeChange", false)) return
    emit(
      "contentSizeChange",
      mapOf(
        "height" to height,
        "width" to width,
      ),
    )
  }

  internal fun showFullscreen(
    fullscreen: View,
    callback: WebChromeClient.CustomViewCallback,
  ) {
    hideFullscreen()
    fullscreenView = fullscreen
    fullscreenCallback = callback
    container.addView(
      fullscreen,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      ),
    )
    webView.visibility = View.GONE
  }

  internal fun hideFullscreen() {
    fullscreenView?.let(container::removeView)
    fullscreenView = null
    fullscreenCallback?.onCustomViewHidden()
    fullscreenCallback = null
    webView.visibility = View.VISIBLE
  }

  internal fun showFileChooser(
    callback: ValueCallback<Array<Uri>>,
    parameters: WebChromeClient.FileChooserParams,
  ): Boolean {
    val activity = context.currentActivity ?: return false
    filePathCallback?.onReceiveValue(null)
    filePathCallback = callback
    return try {
      activity.startActivityForResult(
        parameters.createIntent(),
        FILE_CHOOSER_REQUEST_CODE,
      )
      true
    } catch (error: Throwable) {
      filePathCallback = null
      callback.onReceiveValue(null)
      emitRuntimeError(error.message ?: "No file picker can handle this request.")
      false
    }
  }

  internal fun requestGeolocationPermission(
    origin: String,
    callback: GeolocationPermissions.Callback,
  ) {
    if (!configuration.optBoolean("geolocationEnabled", false)) {
      callback.invoke(origin, false, false)
      return
    }
    if (
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    ) {
      callback.invoke(origin, true, false)
      return
    }
    geolocationPermissionCallback?.invoke(
      geolocationPermissionOrigin.orEmpty(),
      false,
      false,
    )
    geolocationPermissionCallback = callback
    geolocationPermissionOrigin = origin
    pendingAndroidPermissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
    requestQueuedAndroidPermissions()
  }

  internal fun requestWebPermissions(request: PermissionRequest) {
    webPermissionRequest?.deny()
    webPermissionRequest = request
    grantedWebResources.clear()
    pendingWebPermissions.clear()
    for (resource in request.resources) {
      when (resource) {
        PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID -> {
          if (configuration.optBoolean("allowsProtectedMedia", false)) {
            grantedWebResources.add(resource)
          }
        }
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
          collectWebPermission(resource, Manifest.permission.RECORD_AUDIO)
        }
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
          collectWebPermission(resource, Manifest.permission.CAMERA)
        }
      }
    }
    if (pendingWebPermissions.isEmpty()) {
      request.grant(grantedWebResources.toTypedArray())
      webPermissionRequest = null
      grantedWebResources.clear()
      return
    }
    pendingAndroidPermissions.addAll(pendingWebPermissions)
    requestQueuedAndroidPermissions()
  }

  private fun collectWebPermission(webResource: String, androidPermission: String) {
    if (
      ContextCompat.checkSelfPermission(context, androidPermission) ==
        PackageManager.PERMISSION_GRANTED
    ) {
      grantedWebResources.add(webResource)
    } else {
      pendingWebPermissions.add(androidPermission)
    }
  }

  private fun requestQueuedAndroidPermissions() {
    if (permissionRequestInFlight || pendingAndroidPermissions.isEmpty()) return
    val activity = context.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      val message = "WebView permissions require a PermissionAwareActivity."
      webPermissionRequest?.deny()
      webPermissionRequest = null
      grantedWebResources.clear()
      pendingWebPermissions.clear()
      geolocationPermissionCallback?.invoke(
        geolocationPermissionOrigin.orEmpty(),
        false,
        false,
      )
      geolocationPermissionCallback = null
      geolocationPermissionOrigin = null
      pendingDownloadRequest = null
      pendingDownloadingMessage = null
      pendingDownloadPermissionMessage = null
      pendingAndroidPermissions.clear()
      emitRuntimeError(message)
      return
    }
    val permissions = pendingAndroidPermissions.toTypedArray()
    pendingAndroidPermissions.clear()
    permissionRequestInFlight = true
    try {
      activity.requestPermissions(
        permissions,
        PERMISSION_REQUEST_CODE,
        permissionListener,
      )
    } catch (error: Throwable) {
      permissionRequestInFlight = false
      webPermissionRequest?.deny()
      webPermissionRequest = null
      grantedWebResources.clear()
      pendingWebPermissions.clear()
      geolocationPermissionCallback?.invoke(
        geolocationPermissionOrigin.orEmpty(),
        false,
        false,
      )
      geolocationPermissionCallback = null
      geolocationPermissionOrigin = null
      pendingDownloadRequest = null
      pendingDownloadingMessage = null
      pendingDownloadPermissionMessage = null
      emitRuntimeError(error.message ?: error.toString())
    }
  }

  private fun download(
    url: String,
    userAgent: String?,
    contentDisposition: String?,
    mediaType: String?,
  ) {
    try {
      val fileName =
        URLUtil
          .guessFileName(url, contentDisposition, mediaType)
          .replace(Regex("""[\\/%"]"""), "_")
      val downloadingMessage =
        configuration.optString(
          "downloadingMessage",
          "Downloading $fileName",
        )
      val permissionMessage =
        configuration.optString(
          "lackPermissionToDownloadMessage",
          "Cannot download files without storage permission.",
        )
      val request =
        DownloadManager.Request(Uri.parse(url))
          .setMimeType(mediaType)
          .setTitle(fileName)
          .setDescription(downloadingMessage)
          .setNotificationVisibility(
            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
          ).setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
      CookieManager.getInstance().getCookie(url)?.let {
        request.addRequestHeader("Cookie", it)
      }
      userAgent?.let { request.addRequestHeader("User-Agent", it) }
      if (
        Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
          ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
          ) != PackageManager.PERMISSION_GRANTED
      ) {
        pendingDownloadRequest = request
        pendingDownloadingMessage = downloadingMessage
        pendingDownloadPermissionMessage = permissionMessage
        pendingAndroidPermissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        requestQueuedAndroidPermissions()
        return
      }
      enqueueDownload(request, downloadingMessage)
    } catch (error: Throwable) {
      val message =
        configuration.optString(
          "lackPermissionToDownloadMessage",
          error.message ?: "Unable to download this file.",
        )
      Toast.makeText(context, message, Toast.LENGTH_LONG).show()
      emitRuntimeError(message)
    }
  }

  private fun enqueueDownload(
    request: DownloadManager.Request,
    downloadingMessage: String,
  ) {
    try {
      val manager = context.getSystemService(android.content.Context.DOWNLOAD_SERVICE)
        as DownloadManager
      manager.enqueue(request)
      Toast.makeText(context, downloadingMessage, Toast.LENGTH_SHORT).show()
    } catch (error: Throwable) {
      val message =
        configuration.optString(
          "lackPermissionToDownloadMessage",
          error.message ?: "Unable to download this file.",
        )
      Toast.makeText(context, message, Toast.LENGTH_LONG).show()
      emitRuntimeError(message)
    }
  }

  internal fun emit(
    type: String,
    extra: Map<String, Any?> = emptyMap(),
  ) {
    val event = baseEvent()
    for ((key, value) in extra) event.putNullable(key, value)
    onEvent(
      JSONObject()
        .put("type", type)
        .put("nativeEvent", event)
        .toString(),
    )
  }

  private fun emitRuntimeError(description: String) {
    emit("runtimeError", mapOf("description" to description))
  }

  private fun baseEvent(): JSONObject =
    JSONObject()
      .put("canGoBack", webView.canGoBack())
      .put("canGoForward", webView.canGoForward())
      .put("loading", webView.progress != 100)
      .put("lockIdentifier", 0)
      .put("target", 0)
      .put("title", webView.title ?: "")
      .put("url", webView.url ?: baseUrl)

  private fun htmlWithBootstrap(): String {
    return html
  }

  private fun javaScriptObjectSource(): String =
    configuration
      .opt("injectedJavaScriptObject")
      ?.takeUnless { it === JSONObject.NULL }
      ?.let { value ->
        val encoded = JSONObject.quote(value.toString())
        """
        window.ReactNativeWebView = window.ReactNativeWebView || {};
        window.ReactNativeWebView.injectedObjectJson = () => $encoded;
        """
      }.orEmpty()

  private fun injectJavaScriptObject() {
    javaScriptObjectSource().takeIf(String::isNotEmpty)?.let { source ->
      webView.evaluateJavascript("(() => {$source})();", null)
    }
  }

  private fun point(x: Int, y: Int): JSONObject =
    JSONObject()
      .put("height", y)
      .put("width", x)
      .put("x", x)
      .put("y", y)

  private fun originAllowed(url: String): Boolean {
    val origin =
      Regex("^[A-Za-z][A-Za-z0-9+.-]+:(//)?[^/]*")
        .find(url)
        ?.value
        .orEmpty()
    val configured = configuration.optJSONArray("originWhitelist")
    val patterns =
      buildList {
        add("about:blank")
        if (configured == null) {
          add("http://*")
          add("https://*")
        } else {
          for (index in 0 until configured.length()) add(configured.getString(index))
        }
      }
    return patterns.any { pattern ->
      val expression =
        pattern
          .split('*')
          .joinToString(".*") { segment -> Regex.escape(segment) }
      Regex("^$expression$").matches(origin)
    }
  }

  private fun openExternalUrl(url: String) {
    try {
      context.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    } catch (_: Throwable) {
      // react-native-webview delegates this to Linking and ignores a rejected
      // openURL promise; a missing external handler must not fail the page.
    }
  }

  companion object {
    private const val BRIDGE_NAME = "ReactNativeWebView"
    private const val CACHE_FORMAT_VERSION = 14
    private const val FILE_CHOOSER_REQUEST_CODE = 51_874
    private const val HISTORY_MESSAGE_PREFIX =
      "{\"channel\":\"react-native-local-webview:history\""
    private const val PERMISSION_REQUEST_CODE = 51_875
    private const val SHOULD_START_TIMEOUT_MILLISECONDS = 250L
    private val FINGERPRINT_PATTERN = Regex("^[a-f0-9]{64}$")
    private val GENERATION_ID_PATTERN = Regex("^\\d+-\\d+-[a-f0-9]{8}-[a-f0-9]{8}$")
  }
}

private fun JSONObject.optNullableString(name: String): String? =
  if (has(name) && !isNull(name)) getString(name) else null

private fun JSONObject.toStringMap(): Map<String, String> =
  keys().asSequence().associateWith(::getString)

private fun JSONObject.putNullable(name: String, value: Any?) {
  put(name, value ?: JSONObject.NULL)
}

private fun String.escapeScriptRawText(): String =
  replace(Regex("</script", RegexOption.IGNORE_CASE), "<\\/script")

private fun normalize(value: String): String {
  val uri = Uri.parse(value)
  return uri.buildUpon().fragment(null).build().toString()
}

private fun parseRange(header: String?, size: Long): ByteRange? {
  if (header.isNullOrBlank()) return ByteRange(0, size)
  if (!header.startsWith("bytes=") || header.contains(',')) return null
  val parts = header.removePrefix("bytes=").split('-', limit = 2)
  if (parts.size != 2) return null
  return if (parts[0].isBlank()) {
    if (size == 0L) return null
    val suffix = parseDecimalClamped(parts[1], size) ?: return null
    if (suffix <= 0) return null
    ByteRange(maxOf(0, size - suffix), size)
  } else {
    val start = parseDecimalClamped(parts[0], size) ?: return null
    if (start >= size) return null
    val inclusiveEnd =
      if (parts[1].isBlank()) size - 1
      else parseDecimalClamped(parts[1], size - 1) ?: return null
    if (inclusiveEnd < start) return null
    ByteRange(start, inclusiveEnd + 1)
  }
}

private fun parseDecimalClamped(value: String, maximum: Long): Long? {
  if (value.isEmpty() || maximum < 0) return null
  var result = 0L
  value.forEach { character ->
    if (character !in '0'..'9') return null
    val digit = character - '0'
    if (result > maximum / 10 || (result == maximum / 10 && digit > maximum % 10)) {
      return maximum
    }
    result = result * 10 + digit
  }
  return result
}
