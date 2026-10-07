# Security

Paseo follows a client-server architecture, similar to Docker. The daemon runs on your machine and manages your coding agents. Clients (the mobile app, CLI, or web interface) connect to the daemon to monitor and control those agents.

Your code never leaves your machine. Paseo is a local-first tool that connects directly to your development environment.

## Architecture

The Paseo daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a VPS, or a Docker container. The daemon listens for connections and manages agent lifecycles.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection** — The daemon connects outbound to our relay server, and clients meet it there. No open ports required.
- **Direct connection** — The daemon listens on a network address and clients connect directly.

## Relay threat model

The relay is designed to be untrusted. All traffic between your phone and daemon is end-to-end encrypted. The relay server cannot read your messages, see your code, or modify traffic without detection. Even if the relay is compromised, your data remains protected.

### How it works

1. The daemon generates a persistent Curve25519 keypair on first run and stores it at `$PASEO_HOME/daemon-keypair.json` with mode `0600`
2. The pairing URL (rendered as a QR code or opened directly) carries the daemon's public key in its URL fragment (`https://app.paseo.sh/#offer=...`). Fragments are not sent to the web server, so `app.paseo.sh` never sees the key.
3. When the phone connects via the relay, it generates a fresh ephemeral Curve25519 keypair and sends an `e2ee_hello` message containing its public key. The daemon will not process any application messages until this handshake completes.
4. Both sides perform a Curve25519 ECDH key exchange to derive a shared key. All subsequent messages are encrypted with XSalsa20-Poly1305 (NaCl `box`). The encrypted bundle is `[24-byte nonce][ciphertext]`. Peers optionally negotiate `binaryCiphertext` in `e2ee_hello` / `e2ee_ready`: negotiated application text is carried as a base64 WebSocket text frame, while application binary is carried as a raw WebSocket binary frame. A peer that does not negotiate the capability uses base64 text frames for both kinds.

The WebSocket opcode is preserved end to end after negotiation; the receiver never guesses whether authenticated plaintext is text or binary from its byte contents. The plaintext handshake remains WebSocket text and contains only public keys and capability declarations.

The relay sees only: IP addresses, timing, message sizes, session IDs, and the plaintext `e2ee_hello` / `e2ee_ready` handshake frames (which contain only public keys). It cannot read message contents, forge messages, or derive encryption keys from observing the handshake.

### Why the relay can't attack you

The daemon requires a valid cryptographic handshake before processing any commands. A compromised relay cannot:

- **Impersonate the daemon to your phone** — Without the daemon's secret key, it cannot derive the shared key, so any traffic it injects fails authenticated decryption on the phone
- **Send commands as you** — The daemon only accepts traffic that decrypts and authenticates under a shared key derived with its own secret key. The phone's keypair is ephemeral per connection, so there is no persistent phone-side secret to steal; protection comes from the daemon's secret key never leaving the daemon.
- **Read your traffic** — All messages are encrypted with XSalsa20-Poly1305 (NaCl box) after the handshake
- **Forge messages** — NaCl box provides authenticated encryption; tampered messages are rejected
- **Replay old messages across sessions** — Each session derives fresh encryption keys, so ciphertext from one session cannot be replayed into another session. Within a live session, replay protection is not yet implemented; the protocol uses random nonces and does not track nonce reuse or message counters.

### Trust model

The QR code or pairing link is the trust anchor. It contains the daemon's public key, which is required to establish the encrypted connection. Treat it like a password — don't share it publicly.

When a daemon password is configured, new relay clients send it in the encrypted `hello` message. This release still admits relay clients that send no credential so existing mobile builds continue to connect. A wrong password is rejected. The next release will require the password for relay connections after updated mobile builds are available.

## Local daemon trust boundary

By default, the daemon binds to `127.0.0.1`. With no password configured, anything that can reach the daemon socket can control the daemon. Loopback is reachable by other users on the machine and by some forwarding tools.

The daemon supports an optional shared-secret password (set via `auth.password` in `config.json` or the `PASEO_PASSWORD` env var; stored bcrypt-hashed). WebSocket clients send the password in `hello`; the daemon sends no session data before admission. Direct connections still accept bearer headers and WebSocket bearer subprotocols for older clients. HTTP stays bearer-header based. Health (`GET /api/health`) and CORS preflight (`OPTIONS`) are exempt; `/api/files/download` and `/mcp/agents` use their own capability tokens.

The daemon writes a new `$PASEO_HOME/local-credential` on every run with mode `0600` and removes it on shutdown. The CLI and desktop main process read it only for the daemon whose PID lock `listen` matches their connection target. A same-user process can read this credential, so the password protects against network clients and other OS users, not processes running as the daemon user. Protect `$PASEO_HOME` accordingly. Relay traffic remains end-to-end encrypted independently of password admission.

Connected clients are trusted operators of the daemon user. File previews follow that authority: a preview request may read any regular file the daemon process can read, while keeping path normalization and symlink checks in the daemon file service. Workspace-relative paths remain a UI convenience, not a security boundary.

When Paseo checks out a change request from a different repository, it does not run that workspace's `paseo.json` setup, automatic terminals, named scripts, or teardown until you explicitly run setup for that workspace. The decision lasts for the workspace and does not re-prompt after new commits. Same-repository changes, ordinary branches, local workspaces, agent launches, terminals, explicit shell commands, and metadata-generation instructions are outside this gate.

If you expose the daemon beyond loopback, such as by binding to `0.0.0.0`, forwarding it through a tunnel or reverse proxy, or publishing it from a Docker container, you are responsible for restricting and securing that access. Setting a password is strongly recommended in that case.

In Docker, the official image runs the daemon and agents as the non-root
`paseo` user by default. Mounted workspaces and credentials are still fully
available to anything the agents run inside the container.

For remote access, use the relay connection. It is the supported path for reaching the daemon off-machine, and it adds end-to-end encryption plus a pairing handshake before commands are accepted.

Host header validation and CORS origin checks are defense-in-depth controls for localhost exposure. They help block DNS rebinding and browser-based attacks, but they do not replace network isolation.

## DNS rebinding protection

CORS is not a complete security boundary. It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo validates the `Host` header on every HTTP request and every WebSocket upgrade against an allowlist (Vite-style semantics). By default, only `localhost`, `*.localhost`, and any literal IP address (IPv4 or IPv6) are accepted. Additional hostnames can be configured via `hostnames` in `config.json` or the `PASEO_HOSTNAMES` env var (comma-separated; entries beginning with `.` match a domain and its subdomains; the value `true` disables the allowlist entirely). Requests with unrecognized hosts are rejected with `403 Host not allowed`.

## HTML file preview

Previewing an `.html` file in the file pane renders it as a page, so markup an agent wrote — or markup that arrived with a repo you cloned — executes when you open it. The preview is built to contain that, not to trust it.

The document loads with an opaque origin and a policy that permits inline script and style and refuses everything else: no remote script, font, image, or media; no `fetch`, XHR, WebSocket, or beacon; no form posts; no plugins; no nested frames. It has no access to Paseo's DOM, and storage and cookie APIs throw inside it rather than returning anything. It cannot navigate the top window, and it cannot open popups. It cannot read any file but itself.

One gap remains on web and desktop: a sandboxed document may navigate _itself_, and no CSP directive in current browsers prevents that. `navigate-to` was dropped from CSP Level 3 and is not enforced, and `<meta http-equiv="refresh">` needs no script at all. A hostile page can therefore reach a server by navigating away, carrying data available inside the preview, such as its own contents, browser and device properties, user input inside the page, and your IP address. It cannot read Paseo, another file, storage, or cookies.

Native builds narrow this gap rather than closing it outright. The WebView refuses every navigation after the initial document, but that decision is made in the app's JavaScript, and on Android the WebView falls back to allowing a navigation when the decision doesn't come back in time. Treat it as a strong mitigation, not a guarantee: if the JS thread is stalled at the moment a page navigates, the same leak is possible there too.

If you don't trust a page, read it in `Source`, which executes nothing. Source is available as an editable view on supported web hosts and a read-only view everywhere else.

## Inline HTML renders

An agent can publish a page into its conversation with `html_render`. The daemon stores it under that agent, limits its size and local image inputs, and delivers it over the authenticated session. The web and Electron viewer use an opaque-origin `srcDoc` iframe with `sandbox="allow-scripts"`; native uses an incognito WebView with an inert `about:blank` base and a navigation latch. The CSP allows inline scripts and HTTPS scripts, styles, images, fonts, and media from any host. A page can make outbound HTTPS requests through those resource loads and leak data present in its page. `connect-src 'none'` blocks fetch, XHR, and WebSocket only; it does not isolate the page from the network. Forms and nested frames are blocked. This is accepted because the page contains only what the agent wrote, and that agent already has the same data and network access. Web accepts validated HTTP(S) link messages only from its own frame and opens a link only while that frame is focused and the browser reports user activation. Native requires a host-owned **Open link?** confirmation showing the full URL before opening any HTTP(S) new-window request; a WebView new-window event alone does not prove a user click.

Page scripts can take focus inside their own frame. The CSP does not stop a page navigating itself with script or meta refresh; on web and Electron that can make an outbound request with the page's own data and the reader's IP address. On Android, the navigation latch can allow a page-initiated navigation if WebView times out after 250 ms waiting for the JavaScript decision. A render has no access to the Paseo document, its cookies or storage.

Codex `visualize` references use a separate fragment host. The daemon reads a bounded UTF-8 file only from the saved Codex agent's cwd, workspace, or its own thread visualization directory, and rejects symlinked paths below those trusted roots. The web frame has the same opaque origin and sandbox; its CSP permits resource loads only from seven named CDN and font hosts, with `connect-src` limited to `blob:` and `data:`. A fragment can still send its own data through allowed resource URLs or a self-navigation. The page contains what the agent wrote; the agent already has that data and network access. State writes are agent- and path-scoped. Web follow-ups and external links require frame focus and browser user activation. Native follow-ups require a host-owned confirmation that labels the fragment title as page-supplied and shows the exact prompt; native external links require a separate host-owned confirmation showing the full URL. The Android navigation timing residual above also applies to fragments.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their authentication. Each agent provider handles its own credentials. Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Forge host trust

Paseo only talks to a forge host that is either a known cloud host or one the forge CLI is already authenticated to. It never probes or routes credentials to an unauthenticated, remote-derived host.

A pull request an agent watches with `watch_pull_request` brings other people's text into that agent's conversation without a human in between: each wake quotes up to 200 characters of every new comment or review, from anyone who can comment on the pull request. Treat a watching agent the way you treat one you asked to read the pull request, and don't run it unattended with broader permissions than you would give that content. Paseo reads the pull request with the forge CLI's own credentials and writes nothing to the forge.

## Reporting vulnerabilities

If you discover a security vulnerability, please report it privately by emailing hello@moboudra.com. Do not open a public issue.
