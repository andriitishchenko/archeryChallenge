"""Transactional email helpers."""
import logging
import smtplib
from email.message import EmailMessage

from core.config import settings

log = logging.getLogger(__name__)


def send_password_reset_email(recipient: str, reset_url: str) -> bool:
    """Send a password reset email, returning False when SMTP is not configured."""
    if not settings.SMTP_HOST:
        if settings.DEBUG:
            log.warning("SMTP_HOST is not configured; password reset URL: %s", reset_url)
        else:
            log.error("SMTP_HOST is not configured; password reset email was not sent")
        return False

    message = EmailMessage()
    message["Subject"] = "Reset your ArrowMatch password"
    message["From"] = settings.EMAIL_FROM
    message["To"] = recipient
    message.set_content(
        "We received a request to reset your ArrowMatch password.\n\n"
        f"Open this link within {settings.PASSWORD_RESET_EXPIRE_MINUTES} minutes:\n"
        f"{reset_url}\n\n"
        "If you did not request this, you can safely ignore this email."
    )

    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as smtp:
            if settings.SMTP_USE_TLS:
                smtp.starttls()
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            smtp.send_message(message)
        return True
    except (OSError, smtplib.SMTPException):
        log.exception("Failed to send password reset email")
        return False
