cmake_minimum_required(VERSION 3.22.1)
project(rish_guest_jni LANGUAGES CXX)

# The pinned rish runtime is staged by scripts/prepare-rish-android.sh as a
# prebuilt cdylib per ABI plus the matching rish.h. Gradle passes the staging
# directory in; nothing here downloads or builds Rust.
if(NOT DEFINED RISH_FFI_DIR)
  message(FATAL_ERROR "RISH_FFI_DIR is required; run scripts/prepare-rish-android.sh first")
endif()

set(RISH_FFI_LIBRARY "${RISH_FFI_DIR}/jniLibs/${ANDROID_ABI}/librish_ffi.so")
if(NOT EXISTS "${RISH_FFI_LIBRARY}")
  message(FATAL_ERROR "no staged rish runtime for ${ANDROID_ABI}: ${RISH_FFI_LIBRARY}")
endif()

add_library(rish_ffi SHARED IMPORTED)
set_target_properties(
  rish_ffi
  PROPERTIES
    IMPORTED_LOCATION "${RISH_FFI_LIBRARY}"
    # Rust cdylibs carry no ELF SONAME by default. Without this, CMake can
    # record the build-machine absolute path in DT_NEEDED instead of the bare
    # file name the Android loader resolves from nativeLibraryDir.
    IMPORTED_NO_SONAME TRUE
)

add_library(rish_guest_jni SHARED rish_guest_jni.cpp)
target_include_directories(rish_guest_jni PRIVATE "${RISH_FFI_DIR}/include")
target_compile_features(rish_guest_jni PRIVATE cxx_std_17)
target_compile_options(rish_guest_jni PRIVATE -fvisibility=hidden -Wall -Wextra)
target_link_libraries(rish_guest_jni PRIVATE rish_ffi)
