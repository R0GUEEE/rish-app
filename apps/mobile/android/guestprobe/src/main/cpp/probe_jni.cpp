// Diagnostics the Kotlin side cannot perform.
//
// The guest rejected every boot in about 30ms, identically at 768, 512 and 256
// MiB. That is far too fast to have read a 12 MiB kernel, and the memory size
// is plainly not the variable, so the failure is at the very start of
// rish_vm_boot_session -- which returns a null pointer and no reason. These
// three calls test the three things that start could plausibly need, from
// native code, in the same process, and report errno rather than a verdict.
#include <jni.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

std::string Describe(const char *what, bool ok, const std::string &detail) {
  std::string line = what;
  line += ok ? "  OK" : "  FAILED";
  if (!detail.empty()) {
    line += "  ";
    line += detail;
  }
  return line;
}

std::string ErrnoText() {
  std::string text = "errno=";
  text += std::to_string(errno);
  text += " (";
  text += std::strerror(errno);
  text += ")";
  return text;
}

} // namespace

/**
 * open() + read() of the staged asset, from native code. The Kotlin layer
 * wrote and hashed this file, so Java can plainly reach it; whether the native
 * side sees the same path is a separate question, and one a container that
 * virtualises the filesystem can answer differently.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_tech_zseven_rish_guestprobe_NativeProbe_readFile(JNIEnv *env, jclass,
                                                      jstring path) {
  const char *chars = env->GetStringUTFChars(path, nullptr);
  if (chars == nullptr) return env->NewStringUTF("native read  FAILED  no path");
  std::string result;
  struct stat info {};
  if (::stat(chars, &info) != 0) {
    result = Describe("native stat", false, ErrnoText());
  } else {
    result = Describe("native stat", true, std::to_string(info.st_size) + " bytes");
    int fd = ::open(chars, O_RDONLY);
    if (fd < 0) {
      result += "\n" + Describe("native open", false, ErrnoText());
    } else {
      result += "\n" + Describe("native open", true, "");
      char head[64];
      ssize_t got = ::read(fd, head, sizeof(head));
      if (got < 0) {
        result += "\n" + Describe("native read", false, ErrnoText());
      } else {
        char hex[16 * 3 + 1];
        int used = 0;
        for (ssize_t i = 0; i < got && i < 16; ++i) {
          used += std::snprintf(hex + used, sizeof(hex) - used, "%02x ",
                                static_cast<unsigned char>(head[i]));
        }
        result += "\n" + Describe("native read", true,
                                  std::to_string(got) + " bytes, starts " + hex);
      }
      ::close(fd);
    }
  }
  env->ReleaseStringUTFChars(path, chars);
  return env->NewStringUTF(result.c_str());
}

/** An anonymous mapping the size of the guest's RAM. */
extern "C" JNIEXPORT jstring JNICALL
Java_tech_zseven_rish_guestprobe_NativeProbe_mapAnonymous(JNIEnv *env, jclass,
                                                          jint mib) {
  size_t bytes = static_cast<size_t>(mib) * 1024u * 1024u;
  void *address = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  std::string label = "mmap " + std::to_string(mib) + " MiB rw";
  if (address == MAP_FAILED) return env->NewStringUTF(Describe(label.c_str(), false, ErrnoText()).c_str());
  // Touch both ends: a reservation that cannot be committed fails here, not above.
  static_cast<char *>(address)[0] = 1;
  static_cast<char *>(address)[bytes - 1] = 1;
  ::munmap(address, bytes);
  return env->NewStringUTF(Describe(label.c_str(), true, "reserved and touched").c_str());
}

/**
 * An executable mapping. A container enforcing W^X refuses this, and an
 * interpreter that compiles anything at all would die exactly this early.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_tech_zseven_rish_guestprobe_NativeProbe_mapExecutable(JNIEnv *env, jclass) {
  size_t bytes = 1024u * 1024u;
  void *address = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE | PROT_EXEC,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (address == MAP_FAILED) return env->NewStringUTF(Describe("mmap 1 MiB rwx", false, ErrnoText()).c_str());
  ::munmap(address, bytes);
  return env->NewStringUTF(Describe("mmap 1 MiB rwx", true, "").c_str());
}
