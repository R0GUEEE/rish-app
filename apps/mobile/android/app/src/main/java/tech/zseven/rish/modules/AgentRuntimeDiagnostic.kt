package tech.zseven.rish.modules

/**
 * What a rejection says beyond its code, for the notice's details: the
 * operation, whether a rule refused or something threw, the class that
 * threw and the app method it threw in. Value-free -- no message, path or
 * anything a person wrote -- and display-only in JS
 * (`agent-runtime-diagnostic.ts`). A bare E_COMPLETION_NATIVE in a
 * tester's screenshot said nothing about where (beta report, 2026-09-29).
 */
internal fun diagnosed(operation: String, code: String, failure: Throwable): String {
    val refused = failure.javaClass.simpleName == "Refused"
    val cause = failure.javaClass.simpleName.filter { it.isLetterOrDigit() || it == '_' || it == '$' }
        .take(64).ifEmpty { "Unknown" }
    val site = failure.stackTrace.firstOrNull { it.className.startsWith("tech.zseven.rish") }?.let { frame ->
        "${frame.className.substringAfterLast('.')}.${frame.methodName}:${frame.lineNumber}"
            .filter { it.isLetterOrDigit() || it in "_.\$:" }.take(120)
    }
    return buildString {
        append(code).append('\n')
        append("agent_runtime/v1 operation=").append(operation)
        append(" kind=").append(if (refused) "refused" else "exception")
        append(" code=").append(code)
        append(" cause=").append(cause)
        if (!site.isNullOrEmpty()) append(" site=").append(site)
    }
}
