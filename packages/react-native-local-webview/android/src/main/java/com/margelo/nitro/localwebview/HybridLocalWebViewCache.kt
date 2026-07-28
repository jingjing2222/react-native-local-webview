package com.margelo.nitro.localwebview

import android.util.Base64
import android.webkit.CookieManager
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

private const val DOWNLOAD_LIMIT_PREFIX = "LOCAL_WEBVIEW_DOWNLOAD_LIMIT"
private const val DOWNLOAD_BUFFER_BYTES = 256 * 1024

private fun cacheFile(path: String): File =
  if (path.startsWith("file://")) File(URI(path)) else File(path)

private fun prepareCacheDestination(file: File) {
  val parent = file.parentFile
  check(parent == null || parent.isDirectory || parent.mkdirs()) {
    "Could not create cache directory $parent"
  }
  if (file.exists()) check(file.delete()) { "Could not replace cache file $file" }
}

private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

private fun nativeDigestName(algorithm: String): String =
  when (algorithm) {
    "sha256" -> "SHA-256"
    "sha384" -> "SHA-384"
    "sha512" -> "SHA-512"
    else -> error("Unsupported hash algorithm: $algorithm")
  }

class HybridLocalWebViewCache : HybridLocalWebViewCacheSpec() {
  private val activeDownloads = ConcurrentHashMap<String, HttpURLConnection>()
  private val cancelledDownloads = ConcurrentHashMap.newKeySet<String>()

  override val documentsDirectory: String
    get() =
      NitroModules.applicationContext?.filesDir?.absolutePath
        ?: error("React Native application context is unavailable.")

  override fun cancelDownload(requestId: String) {
    cancelledDownloads.add(requestId)
    activeDownloads[requestId]?.disconnect()
  }

  override fun copyFile(source: String, destination: String): Promise<Unit> =
    Promise.parallel {
      val target = cacheFile(destination)
      prepareCacheDestination(target)
      FileInputStream(cacheFile(source)).use { input ->
        FileOutputStream(target).use { output -> input.copyTo(output, DOWNLOAD_BUFFER_BYTES) }
      }
    }

  override fun download(requestId: String, requestJson: String): Promise<String> =
    Promise.parallel {
      val request = JSONObject(requestJson)
      val sourceUrl = request.getString("url")
      val url = URL(sourceUrl)
      require(url.protocol == "http" || url.protocol == "https") {
        "Only HTTP and HTTPS downloads are supported."
      }
      val timeoutMs = request.getDouble("timeoutMs")
      require(timeoutMs > 0 && timeoutMs <= Int.MAX_VALUE) {
        "timeoutMs must be a positive 32-bit integer."
      }
      val maximumBytes =
        if (request.has("maxBytes") && !request.isNull("maxBytes")) {
          request.getLong("maxBytes").also { require(it >= 0) { "maxBytes must not be negative." } }
        } else {
          null
        }
      val downloadDigests = linkedMapOf<String, MessageDigest>()
      val hashAlgorithms = request.optJSONArray("hashAlgorithms")
      if (hashAlgorithms != null) {
        for (index in 0 until hashAlgorithms.length()) {
          val algorithm = hashAlgorithms.getString(index)
          downloadDigests.putIfAbsent(
            algorithm,
            MessageDigest.getInstance(nativeDigestName(algorithm)),
          )
        }
      }
      if (cancelledDownloads.contains(requestId)) {
        throw InterruptedException("The cache download was cancelled.")
      }

      val connection = url.openConnection() as HttpURLConnection
      activeDownloads[requestId] = connection
      try {
        if (cancelledDownloads.contains(requestId)) {
          throw InterruptedException("The cache download was cancelled.")
        }
        connection.instanceFollowRedirects = false
        connection.requestMethod = "GET"
        connection.connectTimeout = timeoutMs.toInt()
        connection.readTimeout = timeoutMs.toInt()
        connection.useCaches = false
        connection.setRequestProperty("Accept-Encoding", "identity")
        val headers = request.optJSONObject("headers")
        if (headers != null) {
          for (key in headers.keys()) connection.setRequestProperty(key, headers.getString(key))
        }
        if (connection.getRequestProperty("Cookie") == null) {
          CookieManager.getInstance().getCookie(sourceUrl)?.let {
            connection.setRequestProperty("Cookie", it)
          }
        }

        connection.connect()
        val status = connection.responseCode
        val declaredBytes = connection.contentLengthLong
        if (maximumBytes != null && declaredBytes >= 0 && declaredBytes > maximumBytes) {
          throw IllegalStateException(
            "$DOWNLOAD_LIMIT_PREFIX|$maximumBytes|$declaredBytes|$sourceUrl"
          )
        }

        val writesFile = status in 200..299
        val target = cacheFile(request.getString("path"))
        if (writesFile) prepareCacheDestination(target)
        var receivedBytes = 0L
        val responseStream =
          try {
            connection.errorStream ?: connection.inputStream
          } catch (_: java.io.FileNotFoundException) {
            null
          }
        val output =
          if (writesFile) BufferedOutputStream(FileOutputStream(target), DOWNLOAD_BUFFER_BYTES)
          else null
        try {
          if (responseStream != null) {
            BufferedInputStream(responseStream).use { input ->
              val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
              while (true) {
                if (cancelledDownloads.contains(requestId)) {
                  throw InterruptedException("The cache download was cancelled.")
                }
                val count = input.read(buffer)
                if (count < 0) break
                receivedBytes += count
                if (maximumBytes != null && receivedBytes > maximumBytes) {
                  throw IllegalStateException(
                    "$DOWNLOAD_LIMIT_PREFIX|$maximumBytes|$receivedBytes|$sourceUrl"
                  )
                }
                if (writesFile) {
                  for (digest in downloadDigests.values) digest.update(buffer, 0, count)
                }
                output?.write(buffer, 0, count)
              }
            }
          }
        } finally {
          output?.close()
        }

        val cookieManager = CookieManager.getInstance()
        var storedCookie = false
        for ((name, values) in connection.headerFields) {
          if (name?.equals("Set-Cookie", ignoreCase = true) == true) {
            values.forEach { cookieManager.setCookie(connection.url.toString(), it) }
            storedCookie = true
          }
        }
        if (storedCookie) cookieManager.flush()
        val responseHeaders = JSONObject()
        for ((name, values) in connection.headerFields) {
          if (name != null) responseHeaders.put(name, values.joinToString(", "))
        }
        val result =
          JSONObject()
          .put("bytesWritten", if (writesFile) receivedBytes else 0)
          .put("headers", responseHeaders)
          .put("responseUrl", connection.url.toString())
          .put("status", status)
          .put("wroteFile", writesFile)
        if (writesFile && downloadDigests.isNotEmpty()) {
          result.put("digests", JSONObject(downloadDigests.mapValues { hex(it.value.digest()) }))
        }
        result.toString()
      } catch (error: Throwable) {
        runCatching { cacheFile(JSONObject(requestJson).getString("path")).delete() }
        throw error
      } finally {
        activeDownloads.remove(requestId)
        cancelledDownloads.remove(requestId)
        connection.disconnect()
      }
    }

  override fun exists(path: String): Promise<Boolean> =
    Promise.parallel { cacheFile(path).exists() }

  override fun hashFile(path: String, algorithmsJson: String): Promise<String> =
    Promise.parallel {
      val algorithms = JSONArray(algorithmsJson)
      val digests = linkedMapOf<String, MessageDigest>()
      for (index in 0 until algorithms.length()) {
        val algorithm = algorithms.getString(index)
        digests.putIfAbsent(algorithm, MessageDigest.getInstance(nativeDigestName(algorithm)))
      }
      BufferedInputStream(FileInputStream(cacheFile(path))).use { input ->
        val buffer = ByteArray(1024 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          for (digest in digests.values) digest.update(buffer, 0, count)
        }
      }
      JSONObject(digests.mapValues { hex(it.value.digest()) }).toString()
    }

  override fun listDirectory(path: String): Promise<Array<String>> =
    Promise.parallel {
      cacheFile(path).list()
        ?: throw IllegalStateException("Could not list cache directory $path")
    }

  override fun makeDirectory(path: String): Promise<Unit> =
    Promise.parallel {
      val directory = cacheFile(path)
      check(directory.isDirectory || directory.mkdirs()) {
        "Could not create cache directory $directory"
      }
    }

  override fun moveFile(source: String, destination: String): Promise<Unit> =
    Promise.parallel {
      val sourceFile = cacheFile(source)
      val destinationFile = cacheFile(destination)
      prepareCacheDestination(destinationFile)
      if (!sourceFile.renameTo(destinationFile)) {
        FileInputStream(sourceFile).use { input ->
          FileOutputStream(destinationFile).use { output ->
            input.copyTo(output, DOWNLOAD_BUFFER_BYTES)
          }
        }
        check(sourceFile.delete()) { "Could not remove moved source file $sourceFile" }
      }
    }

  override fun readFile(path: String, encoding: String): Promise<String> =
    Promise.parallel {
      val bytes = cacheFile(path).readBytes()
      encode(bytes, encoding)
    }

  override fun readFileRange(
    path: String,
    start: Double,
    end: Double,
    encoding: String,
  ): Promise<String> =
    Promise.parallel {
      require(start.isFinite() && end.isFinite() && start >= 0 && end >= start) {
        "The requested file range is invalid."
      }
      require(start % 1.0 == 0.0 && end % 1.0 == 0.0 && end <= Long.MAX_VALUE.toDouble()) {
        "The requested file range is invalid."
      }
      val lengthLong = end.toLong() - start.toLong()
      require(lengthLong <= Int.MAX_VALUE) { "The requested file range is too large." }
      val bytes = ByteArray(lengthLong.toInt())
      RandomAccessFile(cacheFile(path), "r").use { file ->
        file.seek(start.toLong())
        file.readFully(bytes)
      }
      encode(bytes, encoding)
    }

  override fun remove(path: String): Promise<Unit> =
    Promise.parallel {
      val file = cacheFile(path)
      if (file.exists()) check(file.deleteRecursively()) { "Could not remove cache path $file" }
    }

  override fun stat(path: String): Promise<Double> =
    Promise.parallel {
      val file = cacheFile(path)
      check(file.exists()) { "Cache path does not exist: $file" }
      file.length().toDouble()
    }

  override fun writeFile(path: String, value: String, encoding: String): Promise<Unit> =
    Promise.parallel {
      val bytes =
        when (encoding) {
          "base64" -> Base64.decode(value, Base64.DEFAULT)
          "utf8" -> value.toByteArray(Charsets.UTF_8)
          else -> error("Unsupported file encoding: $encoding")
        }
      val target = cacheFile(path)
      val parent = target.parentFile
      check(parent == null || parent.isDirectory || parent.mkdirs()) {
        "Could not create cache directory $parent"
      }
      val temporary = File(parent, "${target.name}.write-${System.nanoTime()}")
      try {
        FileOutputStream(temporary).use { it.write(bytes) }
        if (target.exists()) check(target.delete()) { "Could not replace cache file $target" }
        check(temporary.renameTo(target)) { "Could not commit cache file $target" }
      } finally {
        temporary.delete()
      }
    }

  private fun encode(bytes: ByteArray, encoding: String): String =
    when (encoding) {
      "base64" -> Base64.encodeToString(bytes, Base64.NO_WRAP)
      "utf8" -> bytes.toString(Charsets.UTF_8)
      else -> error("Unsupported file encoding: $encoding")
    }
}
