# Reporting a security problem

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: go to the **Security** tab of
this repository and choose **Report a vulnerability**. That opens a private
thread visible only to you and the maintainers.

If that is not available to you, contact the repository owner through their
GitHub profile and ask for a private channel. Do not put details in a public
comment in the meantime.

## What to include

- What an attacker can do, stated plainly. "Any signed-in user can read any
  other user's documents" is a report; "the ACL looks weak" is not.
- The steps to reproduce it, or a proof of concept.
- The version — a commit hash, or the tag you deployed.
- How your instance is configured, if it matters: whether it is behind a
  reverse proxy, whether `AEOLUS_TRUST_PROXY` is set, whether the sandbox is
  in `enforce`.

## What happens next

You will get an acknowledgement. There is no paid staff behind this and no
service-level agreement; it is a project someone maintains. A fix will be
worked on in a private fork, released, and the report credited unless you would
rather it were not.

Please give it a reasonable window before disclosing publicly. If you have not
heard anything at all after two weeks, assume the message was missed and say so
publicly rather than sitting on it indefinitely.

## Scope

In scope: this repository's code, the images its Dockerfiles build, and the
default configuration in `docker-compose.yml` and `.env.example`.

Out of scope, because they are the operator's decisions and not the software's:

- An instance deliberately run without TLS, or with `AEOLUS_COOKIE_SECURE`
  off behind https.
- `AEOLUS_TRUST_PROXY=true` on a network where the app can be reached
  directly. The application says what that costs; see `.env.example`.
- Anything that requires the operator's own database credentials or shell
  access to the host.
- Denial of service through resource exhaustion on an instance with no rate
  limiting in front of it.

## Things that are already known, and deliberate

These are documented decisions rather than oversights. A report about one of
them is welcome if you can show the reasoning is wrong, but it is not news.

**The compile engines run untrusted input.** A LaTeX document is a program.
`\input{/etc/passwd}` is valid LaTeX, and Tectonic has no path sandbox of its
own. Aeolus confines the engines with Landlock (`AEOLUS_SANDBOX_MODE`), and
that mode defaults to `audit`, which logs and blocks nothing, because `enforce`
fails closed on a kernel or container runtime without Landlock and would break
every compile on such a host. **Turn it to `enforce`.** The worker prints at
boot whether the host supports it.

**There is no self-service password reset.** It would need outbound mail, which
a self-hosted install may not have. An administrator issues a new passphrase.

**Passphrase storage is scrypt, not Argon2id.** Argon2id is the better modern
choice. Every Node binding for it is a native module, and a native module is a
build that can fail on somebody's architecture — which for a project people
install themselves is a worse failure than the one it prevents. The parameters
travel with each stored hash, so they can be raised later without invalidating
anyone's credential, and a hash made with older parameters is upgraded silently
the next time its owner signs in.

**Sign-in is rate limited by IP address.** Behind a reverse proxy that only
works if `AEOLUS_TRUST_PROXY` names the proxy. Unset, every request looks like
it came from the proxy and the limit is one bucket shared by everyone. The
per-account lockout — ten failures, fifteen minutes — is the layer that does
not depend on getting that right.
