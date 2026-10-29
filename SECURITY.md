# Reporting a security issue

Use GitHub's [private vulnerability reporting form](https://github.com/A-Box-of-Tools/abox-tools-plugin/security/advisories/new)
for suspected vulnerabilities. Include the affected release, platform, a
minimal reproduction using disposable files, and the expected security impact.
Do not post private documents, photographs, credentials, or sensitive paths in
a public issue.

The maintainers review reports and investigate reproducible issues with the
current release. This repository does not promise a fixed response time. For
ordinary installation problems or feature requests, use the public issue
tracker with any sensitive details removed.

## File and live-session boundaries

The 66 file-processing operations work locally. Their browser contexts remain
offline, load bundled processing modules and expose no HTTP file server. Output
paths must be new, and file operations do not activate cameras or microphones.

The separate live companion is an opt-in exception for direct text/file sharing,
camera video and voice. It uses an isolated visible browser with bundled assets
and fixed abox.tools pairing endpoints. No transport or capture starts merely
because the window opens. The person starts or connects, grants any requested
device permission and handles access links/approvals in that window.

The loopback-looking companion URL is intercepted inside its browser context;
there is no listening local HTTP port. Its narrow native binding accepts only
the owned page's main frame at its exact entry URL. It supplies configuration,
safe status, shutdown and bounded receive-save operations, rather than arbitrary
filesystem reads or path-selected writes. Peer filenames never become output
paths. New receive files are published exclusively; unfinished files are removed
on shutdown, while completed saves remain.

Live status excludes pairing secrets and user content. Direct WebRTC transport
is encrypted, but an invitation can grant access or the ability to request it,
and the receiving person can retain data independently. Host-only ICE/no-STUN mode is a connectivity
restriction, not proof of a private-subnet boundary or a person's identity.
The pairing service still sees connection/room/negotiation metadata; see
[Privacy](PRIVACY.md). There is no relay, discovery or built-in recording.

Companion sessions belong to one adapter process and expire automatically.
The implementation checks stale sessions and permission completions so stopping
does not revive an earlier capture or publish an unfinished receive afterward.
Tests using fake devices or isolated browser routes do not establish physical
device compatibility or successful pairing between a user's actual devices.
