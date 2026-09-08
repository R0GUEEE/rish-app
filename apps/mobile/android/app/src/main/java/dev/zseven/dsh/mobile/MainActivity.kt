package dev.zseven.dsh.mobile

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: android.os.Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) dev.zseven.rish.tasks.TaskExperience.open(intent)
  }
  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    dev.zseven.rish.tasks.TaskExperience.open(intent)
  }
  override fun onResume() {
    super.onResume()
    dev.zseven.rish.tasks.TaskExperience.resume()
  }
  override fun onStop() {
    dev.zseven.rish.tasks.TaskExperience.pause()
    super.onStop()
  }


  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "DSHMobile"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
