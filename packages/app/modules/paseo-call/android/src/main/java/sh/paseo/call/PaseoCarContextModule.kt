package sh.paseo.call

import android.app.UiModeManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val AUDIO_ROUTE_CHANGED = "onAudioRouteChanged"
private const val MOTION_ACTIVITY = "onMotionActivity"
private const val CAR_MODE_CHANGED = "onCarModeChanged"

/** Car signals for the voice call's On the go mode: system car mode and Bluetooth outputs. */
class PaseoCarContextModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var carModeReceiver: BroadcastReceiver? = null
  private var deviceCallback: AudioDeviceCallback? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PaseoCarContext")

    Events(AUDIO_ROUTE_CHANGED, MOTION_ACTIVITY, CAR_MODE_CHANGED)

    Function("getAudioRoute") { describeRoute() }

    Function("getCarMode") { isCarMode() }

    // Activity Recognition needs Play Services, which the F-Droid build can't ship.
    Function("getMotionAuthorization") { "unavailable" }

    AsyncFunction("requestMotionAuthorization") { "unavailable" }

    AsyncFunction("startObserving") { _: Boolean -> startObserving() }

    Function("stopObserving") { stopObserving() }

    OnDestroy { stopObserving() }
  }

  private fun audioManager(): AudioManager =
    context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private fun isCarMode(): Boolean {
    val uiModeManager = context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    return uiModeManager.currentModeType == Configuration.UI_MODE_TYPE_CAR
  }

  private fun startObserving() {
    stopObserving()
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val carMode = intent.action == UiModeManager.ACTION_ENTER_CAR_MODE
        sendEvent(CAR_MODE_CHANGED, mapOf("carMode" to carMode))
      }
    }
    val filter = IntentFilter().apply {
      addAction(UiModeManager.ACTION_ENTER_CAR_MODE)
      addAction(UiModeManager.ACTION_EXIT_CAR_MODE)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
    carModeReceiver = receiver

    val callback = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
        sendEvent(AUDIO_ROUTE_CHANGED, describeRoute())
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
        sendEvent(AUDIO_ROUTE_CHANGED, describeRoute())
      }
    }
    audioManager().registerAudioDeviceCallback(callback, mainHandler)
    deviceCallback = callback
  }

  private fun stopObserving() {
    val reactContext = appContext.reactContext ?: return
    carModeReceiver?.let { runCatching { reactContext.unregisterReceiver(it) } }
    carModeReceiver = null
    deviceCallback?.let {
      (reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
        .unregisterAudioDeviceCallback(it)
    }
    deviceCallback = null
  }

  /** Android lists every connected output, not the active route, so Bluetooth means "connected". */
  private fun describeRoute(): Map<String, Any> {
    val outputs = audioManager().getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { device ->
      val name = device.productName?.toString().orEmpty()
      val address = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) device.address else ""
      mapOf(
        "portType" to portType(device.type),
        "uid" to address.ifBlank { "name:$name" },
        "name" to name,
      )
    }
    return mapOf("outputs" to outputs)
  }

  private fun portType(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetoothHFP"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetoothA2DP"
    AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "bluetoothLE"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "builtInSpeaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtInReceiver"
    else -> "android:$type"
  }
}
