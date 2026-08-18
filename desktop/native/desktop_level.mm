#include <node_api.h>

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

namespace {

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value SetDesktopLevel(napi_env env, napi_callback_info info) {
  size_t argumentCount = 1;
  napi_value arguments[1];
  napi_get_cb_info(env, info, &argumentCount, arguments, nullptr, nullptr);

  if (argumentCount != 1) {
    return ThrowTypeError(env, "setDesktopLevel expects an Electron native window handle.");
  }

  bool isBuffer = false;
  napi_is_buffer(env, arguments[0], &isBuffer);
  if (!isBuffer) {
    return ThrowTypeError(env, "The native window handle must be a Buffer.");
  }

  void* bufferData = nullptr;
  size_t bufferLength = 0;
  napi_get_buffer_info(env, arguments[0], &bufferData, &bufferLength);
  if (bufferLength < sizeof(NSView*)) {
    return ThrowTypeError(env, "The native window handle is incomplete.");
  }

  if (![NSThread isMainThread]) {
    return ThrowTypeError(env, "Window level changes must run on the macOS main thread.");
  }

  void* viewPointer = *reinterpret_cast<void**>(bufferData);
  NSView* view = (__bridge NSView*)viewPointer;
  NSWindow* window = view.window;
  if (view == nil || window == nil) {
    return ThrowTypeError(env, "Needle could not resolve the native NSWindow.");
  }

  // Sit above macOS' desktop backdrop while remaining below Finder's icons.
  const CGWindowLevel wallpaperLevel = CGWindowLevelForKey(kCGDesktopWindowLevelKey) + 2;
  window.level = wallpaperLevel;
  window.ignoresMouseEvents = YES;
  window.hasShadow = NO;
  window.collectionBehavior |= NSWindowCollectionBehaviorCanJoinAllSpaces |
    NSWindowCollectionBehaviorStationary |
    NSWindowCollectionBehaviorIgnoresCycle;
  [window orderBack:nil];

  napi_value result;
  napi_create_int32(env, wallpaperLevel, &result);
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"setDesktopLevel", nullptr, SetDesktopLevel, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 1, properties);
  return exports;
}
