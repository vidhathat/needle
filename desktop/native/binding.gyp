{
  "targets": [
    {
      "target_name": "needle_desktop_level",
      "sources": ["desktop_level.mm"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_LDFLAGS": ["-framework Cocoa", "-framework CoreGraphics"]
      }
    },
    {
      "target_name": "needle_media_remote",
      "type": "executable",
      "sources": ["media_remote_helper.mm"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_CFLAGS": ["-fblocks"],
        "OTHER_LDFLAGS": ["-framework Cocoa"]
      }
    }
  ]
}
