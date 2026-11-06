# Security policy

## How to report a vulnerability

If you find a vulnerability in Sugardaddy, **do not open a public
issue**. Tell us privately through one of these two channels:

- **GitHub's private form:** the **Security** tab of this repository
  → **Report a vulnerability**.
- **Email to contacto@seguridadsi.com**, with "Sugardaddy vulnerability" in the
  subject.

If you can, tell us:

- the version (`cat versiones.env` on the node) and the component: console, sensor,
  updater or a decoy;
- how to reproduce it, step by step;
- what impact you think it has.

We accept reports in Spanish and English.

## What we do next

- **Acknowledgment** within 5 business days at most.
- **Assessment:** we tell you whether we reproduced it and what severity we give it.
- **Fix:** it ships in a new signed version, which each node's updater
  applies on its own.
- **Coordinated disclosure:** we agree with you when it becomes public. By
  default, once the fix is published or, at the latest, 90 days after the
  report.
- **Credit:** if you want, we name you in the security advisory.

## Which versions receive fixes

Only the **latest published version**. Leave the updater on to
receive them.

## What is not a vulnerability

The decoys are built to look vulnerable: a decoy accepting weak
passwords, showing an old banner or letting someone "in" is its job.

These are vulnerabilities, for example:

- escaping from a decoy to the sensor, the console or the machine;
- bypassing the console login;
- getting a node to apply a version or a configuration without a valid
  signature.

## What we ask of you

Test only on your own node. Do not attack systems that are not yours, do not
access third-party data and do not run denial-of-service tests.
