#pragma once

// Keep the experimental guest service independent from DEBUG so an opted-in
// device Release build advertises and executes the same bounded tool set.
// CocoaPods sets RISH_GUEST_CGI_ENABLED from RISH_IOS_GUEST_CGI_ENABLED.
#ifndef RISH_GUEST_CGI_ENABLED
#define RISH_GUEST_CGI_ENABLED 0
#endif

#if DEBUG || RISH_GUEST_CGI_ENABLED
#define DSH_GUEST_CGI_AVAILABLE 1
#else
#define DSH_GUEST_CGI_AVAILABLE 0
#endif
