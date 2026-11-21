"""Invitation emails.

Sent over plain SMTP with the standard library. In Docker Compose the API
sends to Mailpit, a local test mail server that catches every message and
shows it at http://localhost:8025, so nothing leaves the machine. A real
deployment points SMTP_HOST at a real mail provider instead; nothing else
changes. With SMTP_HOST unset, no email is sent and the admin copies the link.

A failed email never undoes the invitation: the account and its link are
already saved, and the admin can copy the link from User management.
"""
import html
import logging
import os
import smtplib
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr

log = logging.getLogger("ycq.mailer")

YELLOW, INK, MUTED = "#f7c600", "#1c1c1a", "#62615b"


def app_url() -> str:
    """Where the website is, for links in emails."""
    return os.getenv("APP_URL", "http://localhost:8080").rstrip("/")


def invite_link(token: str) -> str:
    """The token goes after #, which browsers never send to a server, so it
    stays out of web server logs and Referer headers."""
    return f"{app_url()}/setup#{token}"


def inbox_url() -> str | None:
    """The test inbox (Mailpit), shown to admins in development only."""
    return os.getenv("MAIL_INBOX_URL") or None


def _when(t: datetime) -> str:
    return t.strftime("%d %b %Y, %H:%M UTC").lstrip("0")


def invite_message(to: str, name: str, role: str, link: str, expires_at: datetime,
                   invited_by: str) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = "You're invited to Yellow Cab Query"
    msg["From"] = os.getenv("MAIL_FROM", "Yellow Cab Query <no-reply@ycq.local>")
    msg["To"] = formataddr((name, to))
    role_text = "an administrator" if role == "admin" else "a fleet manager"
    first = name.split()[0] if name.split() else name
    hours = round((expires_at - datetime.now(expires_at.tzinfo)).total_seconds() / 3600)
    expiry = f"in {hours} hours ({_when(expires_at)})"
    msg.set_content(
        f"Hi {first},\n\n"
        f"{invited_by} has invited you to Yellow Cab Query as {role_text}.\n\n"
        f"Set your password here (the link works once):\n{link}\n\n"
        f"The link expires {expiry}. If it has expired, ask your "
        "administrator for a new one.\n\n"
        "If you weren't expecting this, you can ignore this email.\n")

    e = html.escape
    msg.add_alternative(f"""\
<!doctype html>
<html><body style="margin:0;background:#f6f5f0;font-family:'Segoe UI',Arial,sans-serif;color:{INK}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0"
             style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #ebe9e2">
        <tr><td style="background:{YELLOW};padding:20px 28px">
          <span style="display:inline-block;background:{INK};color:{YELLOW};font-weight:800;border-radius:8px;
                       padding:4px 8px;margin-right:10px">YC</span>
          <span style="font-weight:700;font-size:17px">Yellow Cab Query</span>
        </td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:22px">You're invited</h1>
          <p style="margin:0 0 8px;line-height:1.55">Hi {e(first)},</p>
          <p style="margin:0 0 20px;line-height:1.55">
            {e(invited_by)} has invited you to Yellow Cab Query as {role_text}.
            Set your own password to get started.</p>
          <a href="{e(link)}" style="display:inline-block;background:{YELLOW};color:{INK};font-weight:700;
             text-decoration:none;padding:12px 22px;border-radius:10px;border:1px solid #d6aa00">
            Set your password</a>
          <p style="margin:20px 0 0;font-size:13px;color:{MUTED};line-height:1.5">
            The link works once and expires {expiry}.
            If it has expired, ask your administrator for a new one.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #ebe9e2;font-size:12px;color:{MUTED}">
          You're receiving this because an administrator added {e(to)}.
          If you weren't expecting it, you can ignore this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
""", subtype="html")
    return msg


def send_invite(to: str, name: str, role: str, link: str, expires_at: datetime,
                invited_by: str) -> bool:
    """True if the email was handed to the mail server."""
    host = os.getenv("SMTP_HOST")
    if not host:
        return False
    try:
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "25")), timeout=5) as smtp:
            smtp.send_message(invite_message(to, name, role, link, expires_at, invited_by))
        return True
    except (OSError, smtplib.SMTPException):
        log.exception("invitation email to %s could not be sent", to)
        return False
