package dev.zseven.dsh.mobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Phase-1 Android bring-up: register the Rish native package that
          // mirrors the 11 iOS modules (modules/rish/ios/Sources). Every method
          // rejects with its JS-recognized "native unavailable" code so the
          // capability probes in apps/mobile/src/native/*.ts stay honest.
          add(dev.zseven.rish.RishNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
