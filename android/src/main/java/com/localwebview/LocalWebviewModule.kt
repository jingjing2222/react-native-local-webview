package com.localwebview

import com.facebook.react.bridge.ReactApplicationContext

class LocalWebviewModule(reactContext: ReactApplicationContext) :
  NativeLocalWebviewSpec(reactContext) {

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  companion object {
    const val NAME = NativeLocalWebviewSpec.NAME
  }
}
