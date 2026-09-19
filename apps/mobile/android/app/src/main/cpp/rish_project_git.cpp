// Reading a repository's state, and nothing else.
//
// The project context asks one question of git: what does this repository
// have in it right now, and which of those files differ from the last
// commit. Everything after that -- which paths are eligible, how a selection
// becomes a snapshot, what a receipt binds -- is decided elsewhere, most of
// it already in the shared core. So this layer holds no policy at all: it
// reads the index and two diffs and answers in JSON.
//
// The answer is deliberately flat and sorted, because the caller compares it
// against what the other host produces for the same repository.

#include <jni.h>

#include <algorithm>
#include <string>
#include <vector>

#include <git2.h>

namespace {

/// A JSON string, escaped the way any JSON writer must.
std::string Quoted(const char *value) {
  std::string out = "\"";
  for (const char *cursor = value == nullptr ? "" : value; *cursor != '\0'; cursor += 1) {
    const unsigned char c = static_cast<unsigned char>(*cursor);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char escape[7];
          snprintf(escape, sizeof(escape), "\\u%04x", c);
          out += escape;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

std::string Oid(const git_oid *id) {
  char hex[GIT_OID_SHA1_HEXSIZE + 1];
  git_oid_tostr(hex, sizeof(hex), id);
  return std::string(hex);
}

/// One entry of the index, before anything decides what to do with it.
struct Entry {
  std::string path;
  std::string oid;
  unsigned int mode = 0;
  unsigned long long size = 0;
  int stage = 0;
  // "unchanged" until a diff says otherwise; "conflicted" when the entry is
  // one side of an unresolved merge.
  std::string state;
};

std::string Failure(const std::string &stage) {
  const git_error *error = git_error_last();
  const std::string why = error != nullptr && error->message != nullptr ? error->message : "";
  return "{\"ok\":false,\"stage\":" + Quoted(stage.c_str()) + ",\"error\":" +
         Quoted(why.c_str()) + "}";
}

/// Marks every path a diff touched with `state`, leaving the rest alone.
void MarkDeltas(std::vector<Entry> &entries, git_diff *diff, const char *state) {
  const size_t count = git_diff_num_deltas(diff);
  for (size_t index = 0; index < count; index += 1) {
    const git_diff_delta *delta = git_diff_get_delta(diff, index);
    if (delta == nullptr) continue;
    const char *path = delta->new_file.path != nullptr ? delta->new_file.path
                                                       : delta->old_file.path;
    if (path == nullptr) continue;
    for (Entry &entry : entries) {
      // A conflicted entry is already saying something more specific.
      if (entry.path == path && entry.state != "conflicted") entry.state = state;
    }
  }
}

}  // namespace

extern "C" {

/// Reads `path` as a repository and answers its index and working state.
///
/// `{"ok":true,"head":…,"branch":…,"state":…,"index_checksum":…,"entries":[…]}`
/// or `{"ok":false,"stage":…,"error":…}`. Entries are sorted by path so two
/// hosts reading one repository produce the same bytes.
JNIEXPORT jstring JNICALL
Java_tech_zseven_rish_runtime_RishLibgit2Native_readRepositoryState(
    JNIEnv *env, jclass, jstring pathValue) {
  const char *path = env->GetStringUTFChars(pathValue, nullptr);
  if (path == nullptr) return env->NewStringUTF("{\"ok\":false,\"stage\":\"path\"}");

  git_repository *repository = nullptr;
  git_index *index = nullptr;
  git_reference *head = nullptr;
  git_commit *commit = nullptr;
  git_tree *tree = nullptr;
  git_diff *staged = nullptr;
  git_diff *unstaged = nullptr;
  std::string answer;

  do {
    if (git_repository_open(&repository, path) != 0) {
      answer = Failure("open");
      break;
    }
    if (git_repository_index(&index, repository) != 0) {
      answer = Failure("index");
      break;
    }
    if (git_index_read(index, 0) != 0) {
      answer = Failure("index_read");
      break;
    }

    std::vector<Entry> entries;
    const size_t count = git_index_entrycount(index);
    entries.reserve(count);
    for (size_t position = 0; position < count; position += 1) {
      const git_index_entry *raw = git_index_get_byindex(index, position);
      if (raw == nullptr || raw->path == nullptr) continue;
      Entry entry;
      entry.path = raw->path;
      entry.oid = Oid(&raw->id);
      entry.mode = raw->mode;
      entry.size = raw->file_size;
      entry.stage = GIT_INDEX_ENTRY_STAGE(raw);
      // A stage other than zero is one side of an unresolved merge, and no
      // diff below will say anything more useful about it.
      entry.state = entry.stage != 0 ? "conflicted" : "unchanged";
      entries.push_back(std::move(entry));
    }

    // HEAD's tree, when there is one. A repository with no commits yet is
    // not an error: everything in its index is simply staged.
    std::string head_oid;
    std::string branch;
    const int head_error = git_repository_head(&head, repository);
    if (head_error == 0) {
      const git_oid *target = git_reference_target(head);
      if (target != nullptr) head_oid = Oid(target);
      const char *shorthand = git_reference_shorthand(head);
      if (shorthand != nullptr) branch = shorthand;
      if (target != nullptr && git_commit_lookup(&commit, repository, target) == 0) {
        if (git_commit_tree(&tree, commit) != 0) tree = nullptr;
      }
    } else if (head_error != GIT_EUNBORNBRANCH && head_error != GIT_ENOTFOUND) {
      answer = Failure("head");
      break;
    }

    git_diff_options options = GIT_DIFF_OPTIONS_INIT;
    options.flags = GIT_DIFF_INCLUDE_TYPECHANGE;
    if (git_diff_tree_to_index(&staged, repository, tree, index, &options) != 0) {
      answer = Failure("diff_staged");
      break;
    }
    // Rename detection, so a moved file reads as one change rather than an
    // addition and a deletion. iOS asks for the same.
    git_diff_find_options find = GIT_DIFF_FIND_OPTIONS_INIT;
    if (git_diff_find_similar(staged, &find) != 0) {
      answer = Failure("find_similar");
      break;
    }
    if (git_diff_index_to_workdir(&unstaged, repository, index, &options) != 0) {
      answer = Failure("diff_unstaged");
      break;
    }
    MarkDeltas(entries, staged, "staged");
    MarkDeltas(entries, unstaged, "modified");

    std::sort(entries.begin(), entries.end(), [](const Entry &left, const Entry &right) {
      if (left.path != right.path) return left.path < right.path;
      return left.stage < right.stage;
    });

    const git_oid *checksum = git_index_checksum(index);
    const std::string checksum_hex = checksum != nullptr ? Oid(checksum) : std::string();

    std::string out = "{\"ok\":true,\"head\":";
    out += head_oid.empty() ? "null" : Quoted(head_oid.c_str());
    out += ",\"branch\":";
    out += branch.empty() ? "null" : Quoted(branch.c_str());
    out += ",\"repository_state\":" +
           std::to_string(git_repository_state(repository));
    out += ",\"index_checksum\":";
    out += checksum_hex.empty() ? "null" : Quoted(checksum_hex.c_str());
    out += ",\"entries\":[";
    for (size_t position = 0; position < entries.size(); position += 1) {
      const Entry &entry = entries[position];
      if (position > 0) out += ",";
      out += "{\"path\":" + Quoted(entry.path.c_str());
      out += ",\"oid\":" + Quoted(entry.oid.c_str());
      out += ",\"mode\":" + std::to_string(entry.mode);
      out += ",\"size\":" + std::to_string(entry.size);
      out += ",\"stage\":" + std::to_string(entry.stage);
      out += ",\"git_state\":" + Quoted(entry.state.c_str());
      out += "}";
    }
    out += "]}";
    answer = std::move(out);
  } while (false);

  if (unstaged != nullptr) git_diff_free(unstaged);
  if (staged != nullptr) git_diff_free(staged);
  if (tree != nullptr) git_tree_free(tree);
  if (commit != nullptr) git_commit_free(commit);
  if (head != nullptr) git_reference_free(head);
  if (index != nullptr) git_index_free(index);
  if (repository != nullptr) git_repository_free(repository);
  env->ReleaseStringUTFChars(pathValue, path);
  return env->NewStringUTF(answer.c_str());
}

}  // extern "C"
