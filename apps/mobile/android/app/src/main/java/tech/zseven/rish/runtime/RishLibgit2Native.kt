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
     *   "index_checksum":…,"entries":[{path,oid,mode,size,stage,git_state}]}`
     * or `{"ok":false,"stage":…,"error":…}`.
     *
     * This layer holds no policy: which of these paths may be sent, and what
     * a selection of them becomes, is decided above it and mostly in the
     * shared core already. Entries come back sorted by path so two hosts
     * reading one repository produce the same bytes.
     */
    @JvmStatic external fun readRepositoryState(path: String): String
}
