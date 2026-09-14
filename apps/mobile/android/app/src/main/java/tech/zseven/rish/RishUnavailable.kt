package tech.zseven.rish

import com.facebook.react.bridge.Promise

/**
 * Shared rejection helper for the phase-1 Android skeleton.
 *
 * Phase 1 is bring-up only: the app must launch, render the home screen, and
 * keep every native capability probe honest. Each registered method therefore
 * rejects with the module's JS-recognized "native unavailable" error code
 * instead of stubbing a success response. The JS wrappers already sanitize
 * these exact codes:
 *
 *   AgentRuntime        -> E_AGENT_NATIVE        (AgentRuntimeFailureCode)
 *   SessionSnapshots    -> E_SESSION_NATIVE      (stableSessionErrorCodes)
 *   LocalProjectContext -> E_CONTEXT_NATIVE      (ProjectContextBridgeErrorCode)
 *   LocalProjects       -> E_PROJECT_NATIVE      (ProjectGitBridgeError)
 *   LocalRuntime        -> E_COMPLETION_NATIVE   (sanitizeCompletionError)
 *   LocalGuest          -> E_GUEST_NATIVE        (sanitizeGuestError)
 *   LocalWorkspaces     -> E_WORKSPACE_UNAVAILABLE
 *   LocalWorkspace      -> E_WORKSPACE_UNAVAILABLE
 *   LocalAttachments    -> E_NATIVE_UNAVAILABLE  (plain "not linked" error)
 *   LocalDocuments      -> E_NATIVE_UNAVAILABLE
 *   LocalMirrors        -> E_NATIVE_UNAVAILABLE
 */
internal object RishUnavailable {
    const val DEFAULT_CODE = "E_NATIVE_UNAVAILABLE"

    fun reject(module: String, code: String, promise: Promise) {
        promise.reject(code, "$module native module is not linked on Android (phase-1 skeleton)")
    }
}
