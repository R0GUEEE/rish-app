package tech.zseven.rish.runtime

internal object AndroidSubscriptionAuthProtocol {
    fun authMethodForStatus(status: String): String =
        if (status == "authorizing" || status == "signed_in") "subscription" else "none"
}
