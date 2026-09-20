package tech.zseven.rish.runtime

/**
 * The vendored libgit2, as staged by scripts/prepare-libgit2-android.sh.
 *
 * A build without the library staged simply does not have it, the same way a
 * build without the agent core does not have the agent: [available] says so
 * rather than the app crashing on a missing symbol.
 */
internal object RishLibgit2Native {
    val available: Boolean by lazy {
        try {
            System.loadLibrary("rish_libgit2_jni")
            true
        } catch (_: UnsatisfiedLinkError) {
            false
        }
    }

    /** The library's own version, for the receipt that records which one ran. */
    @JvmStatic external fun version(): String

    /** The features compiled in, comma separated: threads, https, ssh, nsec. */
    @JvmStatic external fun features(): String

    /**
     * Creates a repository at [path], commits a file into it and reads the
     * commit back. `ok:<message>` or `error:<stage>:<why>`.
     *
     * A floor test, not a feature: the object database, the index and the
     * commit path are what everything above this leans on, and a library that
     * only initialises proves none of them.
     */
    @JvmStatic external fun roundTrip(path: String): String

    /**
     * A repository's index and working state, as JSON.
     *
     * `{"ok":true,"head":…,"branch":…,"repository_state":…,
     *   "index_checksum":…,"entries":[{path,oid,mode,size,stage,staged,unstaged}]}`
     * or `{"ok":false,"stage":…,"error":…}`.
     *
     * [gitDir] is null for a plain repository whose `.git` is in [workDir].
     * A workspace's project is the other shape: a private bare gitdir, paired
     * with the workspace root as its working tree at every open, the way iOS
     * keeps it -- nothing inside the workspace says it is a repository.
     *
     * This layer holds no policy: which of these paths may be sent, and what
     * a selection of them becomes, is decided above it and mostly in the
     * shared core already. Entries come back sorted by path so two hosts
     * reading one repository produce the same bytes.
     */
    @JvmStatic external fun readRepositoryState(gitDir: String?, workDir: String): String

    /**
     * `git init --bare` at [gitDir], paired once with [workDir] to prove the
     * pairing works before the directory is published. `ok` or
     * `error:<stage>:<why>`.
     */
    @JvmStatic external fun initSplitRepository(gitDir: String, workDir: String): String

    /** `git add <path>` for a test that needs more than one staged file. */
    @JvmStatic external fun stagePath(gitDir: String?, workDir: String, path: String): String

    // --- the git panel ----------------------------------------------------
    //
    // Answers come back as UTF-8 bytes of JSON, `{"ok":true,...}` or
    // `{"ok":false,"number":<iOS error number>,"stage":...,"error":...}`.
    // Bytes rather than a string because a patch may hold a four-byte
    // character, which NewStringUTF's modified UTF-8 cannot carry.

    /** `statusForRepository`: branch, head, ahead/behind, and every changed path. */
    @JvmStatic external fun status(gitDir: String?, workDir: String): ByteArray

    /** `diffForRepository`: per-file stats and up to a mebibyte of patch text. */
    @JvmStatic external fun diff(gitDir: String?, workDir: String, staged: Boolean, contextLines: Int): ByteArray

    /** `git add -A`, answering the status that results. */
    @JvmStatic external fun stageAll(gitDir: String?, workDir: String): ByteArray

    /**
     * Commits the index on HEAD when HEAD is [expectedHead] (null: no commit
     * yet). `{"ok":true,"oid":...}`, or 3110 when HEAD moved.
     */
    @JvmStatic external fun commit(
        gitDir: String?, workDir: String, message: String, authorName: String, authorEmail: String,
        expectedHead: String?,
    ): ByteArray
}
