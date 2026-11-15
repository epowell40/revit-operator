# Operator interface and local runtime

The generic UI and execution runtime are shared with the BIMTools workstation
client. Open Core setup starts this application on loopback port3907, alongside
the local backend on7007. The ribbon embeds its interface in Revit; the optional
separate window uses the same runtime, conversations and task controls.

`auth_provider.mjs` is the standalone boundary: local shared-token connections
only, no hosted login, token-store decryption, licensing or commercial account
logic. The private composition supplies its own hosted account adapter. Generic
presentation and execution files are checked for exact parity in integration.

Use the repository-root `Setup-OpenCore.cmd` and `Start-OpenCore.cmd`; do not
point this runtime at a different installation or launch it against somebody
else's backend. Existing native execution authorization, effects, cancellation
and task admission remain authoritative. Computer interaction requires runtime
capability, task permission and an available Windows desktop. It is not granted
merely by opening this interface.

The code is covered by the repository's AGPL-3.0-or-later license. External npm
dependencies retain their own licenses as recorded in package-lock.json. No
private deployment scripts, account adapter, credentials or model fixtures are
included in this application.
