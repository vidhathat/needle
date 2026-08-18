#import <Cocoa/Cocoa.h>
#import <dlfcn.h>

namespace {

using GetNowPlayingInfo = void (*)(dispatch_queue_t, void (^)(CFDictionaryRef));
using GetNowPlayingIsPlaying = void (*)(dispatch_queue_t, void (^)(Boolean));
using GetNowPlayingApplicationPID = void (*)(dispatch_queue_t, void (^)(int));
using RegisterForNowPlayingNotifications = void (*)(dispatch_queue_t);
using SetWantsNowPlayingNotifications = void (*)(Boolean);
using SendCommand = Boolean (*)(uint32_t, CFDictionaryRef);

id ValueWithSuffix(NSDictionary* information, NSString* suffix) {
  for (id key in information) {
    if ([[key description] hasSuffix:suffix]) return information[key];
  }
  return nil;
}

NSString* StringWithSuffix(NSDictionary* information, NSString* suffix, NSString* fallback = @"") {
  id value = ValueWithSuffix(information, suffix);
  if ([value isKindOfClass:[NSString class]]) return value;
  return value ? [value description] : fallback;
}

double NumberWithSuffix(NSDictionary* information, NSString* suffix, double fallback = 0) {
  id value = ValueWithSuffix(information, suffix);
  return [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : fallback;
}

void PrintJson(NSDictionary* payload) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (!data) {
    puts("{\"status\":\"error\",\"reason\":\"json\"}");
    return;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

}  // namespace

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    void* framework = dlopen(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
      RTLD_LAZY | RTLD_LOCAL
    );
    if (!framework) {
      PrintJson(@{ @"status": @"unavailable", @"reason": @"framework" });
      return 0;
    }

    if (argc > 1) {
      auto sendCommand = reinterpret_cast<SendCommand>(
        dlsym(framework, "MRMediaRemoteSendCommand")
      );
      NSString* requestedCommand = [NSString stringWithUTF8String:argv[1]];
      const BOOL isPlay = [requestedCommand isEqualToString:@"play"];
      const BOOL isPause = [requestedCommand isEqualToString:@"pause"];
      if (!sendCommand || (!isPlay && !isPause)) {
        PrintJson(@{ @"status": @"error", @"reason": @"command" });
        dlclose(framework);
        return 0;
      }

      const uint32_t mediaCommand = isPlay ? 0 : 1;
      const Boolean accepted = sendCommand(mediaCommand, nullptr);
      PrintJson(@{
        @"status": accepted ? @"ok" : @"error",
        @"command": requestedCommand,
      });
      dlclose(framework);
      return 0;
    }

    auto getInfo = reinterpret_cast<GetNowPlayingInfo>(dlsym(framework, "MRMediaRemoteGetNowPlayingInfo"));
    auto getIsPlaying = reinterpret_cast<GetNowPlayingIsPlaying>(
      dlsym(framework, "MRMediaRemoteGetNowPlayingApplicationIsPlaying")
    );
    auto getApplicationPID = reinterpret_cast<GetNowPlayingApplicationPID>(
      dlsym(framework, "MRMediaRemoteGetNowPlayingApplicationPID")
    );
    auto registerForNotifications = reinterpret_cast<RegisterForNowPlayingNotifications>(
      dlsym(framework, "MRMediaRemoteRegisterForNowPlayingNotifications")
    );
    auto setWantsNotifications = reinterpret_cast<SetWantsNowPlayingNotifications>(
      dlsym(framework, "MRMediaRemoteSetWantsNowPlayingNotifications")
    );
    if (!getInfo) {
      PrintJson(@{ @"status": @"unavailable", @"reason": @"api" });
      dlclose(framework);
      return 0;
    }

    dispatch_group_t requests = dispatch_group_create();
    dispatch_queue_t callbackQueue = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
    if (setWantsNotifications) setWantsNotifications(true);
    if (registerForNotifications) registerForNotifications(callbackQueue);

    // MediaRemote can return an empty snapshot on a process's first query.
    // Give the registration handshake one run-loop turn before requesting it.
    [NSThread sleepForTimeInterval:0.12];

    __block NSDictionary* information = nil;
    __block BOOL isPlaying = NO;
    __block int applicationPID = 0;

    dispatch_group_enter(requests);
    getInfo(callbackQueue, ^(CFDictionaryRef result) {
      information = result ? [(__bridge NSDictionary*)result copy] : @{};
      dispatch_group_leave(requests);
    });

    if (getIsPlaying) {
      dispatch_group_enter(requests);
      getIsPlaying(callbackQueue, ^(Boolean result) {
        isPlaying = result;
        dispatch_group_leave(requests);
      });
    }

    if (getApplicationPID) {
      dispatch_group_enter(requests);
      getApplicationPID(callbackQueue, ^(int result) {
        applicationPID = result;
        dispatch_group_leave(requests);
      });
    }

    const long completed = dispatch_group_wait(
      requests,
      dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)
    );
    if (completed != 0 || !information) {
      PrintJson(@{ @"status": @"unavailable", @"reason": @"timeout" });
      dlclose(framework);
      return 0;
    }

    NSString* title = StringWithSuffix(information, @"Title");
    NSString* artist = StringWithSuffix(information, @"Artist", @"Unknown artist");
    if (title.length == 0) {
      PrintJson(@{ @"status": @"idle" });
      dlclose(framework);
      return 0;
    }

    NSRunningApplication* application = applicationPID > 0
      ? [NSRunningApplication runningApplicationWithProcessIdentifier:applicationPID]
      : nil;
    NSString* applicationName = application.localizedName ?: @"Browser";
    NSString* bundleIdentifier = application.bundleIdentifier ?: @"";
    const double duration = NumberWithSuffix(information, @"Duration", 1);
    const double elapsedTime = NumberWithSuffix(information, @"ElapsedTime", 0);
    const double playbackRate = NumberWithSuffix(information, @"PlaybackRate", 0);
    const BOOL activelyPlaying = isPlaying || playbackRate > 0;
    NSData* artworkData = ValueWithSuffix(information, @"ArtworkData");
    NSString* artwork = @"";
    if ([artworkData isKindOfClass:[NSData class]] && artworkData.length > 0) {
      NSString* mimeType = StringWithSuffix(information, @"ArtworkMIMEType", @"image/jpeg");
      artwork = [NSString stringWithFormat:
        @"data:%@;base64,%@",
        mimeType,
        [artworkData base64EncodedStringWithOptions:0]
      ];
    }

    NSMutableDictionary* payload = [@{
      @"status": activelyPlaying ? @"playing" : @"paused",
      @"title": title,
      @"artist": artist,
      @"album": StringWithSuffix(information, @"Album"),
      @"duration": @(MAX(1, duration)),
      @"position": @(MAX(0, elapsedTime)),
      @"artwork": artwork,
      @"player": applicationName,
      @"bundleIdentifier": bundleIdentifier,
    } mutableCopy];
    PrintJson(payload);
    dlclose(framework);
  }
  return 0;
}
