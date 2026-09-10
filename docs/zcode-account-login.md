# ZCode account connection in Rish

This is an experimental iOS account connection using the browser/polling
flow observed in the official ZCode 3.11.2 client. It does not embed the
official ZCode agent runtime. The public
[connection guide](https://zcode.z.ai/cn/docs/configuration) distinguishes
BigModel/Z.ai account connection from API-key access; API keys may also use
Coding Plan, so API-key access is not necessarily pay-as-you-go.

## User flow

1. Select the GLM entry in Rish.
2. Open Settings; **Connect GLM account** is near the top.
3. Choose BigModel or Z.ai and sign in on the official authorization page.
   iOS uses a system Safari view inside Rish.
4. After account connection, choose **Verify and use trial** for ZCode trial
   allowance, or **Verify and use subscription** for a personal Coding Plan.
   Account sign-in and usable model access are separate states.
5. Use **Use manual API key** to return to the separately stored manual key.

The account connection is independent from Rish's reserved general account
and the Codex/Claude official-CLI login interfaces.

## Observed protocol

The iOS implementation uses the official ZCode HTTPS origin for login
initialization and polling. Each explicit login creates a new cryptographic
poll bearer, validates the returned authorization URL, and respects expiry,
cancellation, and retry bounds. BigModel and Z.ai have distinct host/path/query
allowlists and exact HTTPS callbacks under the official origin.

OAuth material and selected model credentials remain in separate device-only
Keychain services. Neither is returned to React Native. Selecting subscription
credentials clears the effective credential until personal-plan verification
succeeds; a failed check never falls back to the manual key.

The current resolver reads an existing ZCode-named key in a personal project;
it does not create keys or select team projects. Subscription verification
is required again after the local 15-minute verification lease expires.
There is no invented OAuth refresh endpoint: expired vendor authorization
requires a new sign-in. Sign-out removes local authorization and the selected
provider's derived credential, not a server-side key or the manual key.

### Trial allowance

The official client's trial connection uses a separate ZCode-hosted service:
`GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance` and
`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic`.
These use the ZCode token saved by the account authorization, not the personal
project API key. The request path does not append `/v1/messages`.

Rish keeps trial selection explicit (`bigmodel_trial` or `zai_trial`). A failed
trial check must not switch to a personal subscription, manual key, or general
API balance. The current user confirmed this is a trial account, explaining why
the personal subscription list was empty. Live trial inference still needs
separate verification; account sign-in does not establish it.

## September 10 verification

| Check | Result |
| --- | --- |
| BigModel and Z.ai initialization + pending polling | Official endpoints returned HTTP 200 and valid pending flows with an honest Rish user agent |
| BigModel browser authorization | User completed the official page; Rish subsequently showed signed-in state |
| Restart persistence | Signed-in account remained after installing/reopening the debug build |
| Existing personal key retrieval | Succeeded in the observed BigModel run |
| Personal subscription query | Initially 0 entries for the trial account; after the user purchased Coding Lite, Rish verified the personal Coding Plan |
| Real subscription model invocation | GLM-5.3 returned a JavaScript addition function and examples in the experiment Simulator (about 12 seconds), using the selected personal-plan credential |
| Z.ai completed sign-in | Not yet tested with a real account |
| Trial allowance | Separate resolver and source implemented; actual balance request returned HTTP 400, so trial inference remains unverified |
| Team entitlement | Not implemented |

Earlier external-Safari attempts displayed browser success but did not produce
a saved native session before expiry/reload. They are not counted as successful
Rish login evidence. The later in-app browser attempt produced the saved account.

The empty personal list does not establish that the user has no other plan or
account. Confirm the correct account and entitlement type before extending
routing. Do not advertise full ZCode runtime support or successful subscription
inference from account sign-in alone.
