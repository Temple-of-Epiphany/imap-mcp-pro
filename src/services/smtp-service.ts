import nodemailer from 'nodemailer';
// MailComposer compiles the full MIME we hand to IMAP APPEND. The default
// `transporter.sendMail` path strips Bcc from the DATA payload per RFC 5322
// §3.6.3 — we want Bcc preserved in the Sent folder copy.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapAccount, EmailComposer, SmtpConfig } from '../types/index.js';

export interface SendEmailOutcome {
  /** RFC 5322 Message-ID returned by the SMTP server */
  messageId: string;
  /** Full MIME (with Bcc header preserved) for IMAP APPEND to Sent folder */
  rawMessage: Buffer;
  /** Wall-clock send completion time; used as APPEND internal-date */
  sentAt: Date;
}

export class SmtpService {
  private transporters: Map<string, nodemailer.Transporter> = new Map();

  async createTransporter(account: ImapAccount): Promise<nodemailer.Transporter> {
    if (this.transporters.has(account.id)) {
      return this.transporters.get(account.id)!;
    }

    const smtpConfig = account.smtp || this.getDefaultSmtpConfig(account);
    
    const transporterOptions = {
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.user || account.user,
        pass: smtpConfig.password || account.password,
      },
      tls: smtpConfig.tls,
    };

    const transporter = nodemailer.createTransport(transporterOptions);
    
    // Verify connection
    await transporter.verify();
    
    this.transporters.set(account.id, transporter);
    return transporter;
  }

  private getDefaultSmtpConfig(account: ImapAccount): SmtpConfig {
    // Common SMTP configurations based on IMAP settings
    const commonProviders: { [key: string]: SmtpConfig } = {
      'imap.gmail.com': {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
      },
      'outlook.office365.com': {
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
      },
      'imap-mail.outlook.com': {
        host: 'smtp-mail.outlook.com',
        port: 587,
        secure: false,
      },
      'imap.mail.yahoo.com': {
        host: 'smtp.mail.yahoo.com',
        port: 587,
        secure: false,
      },
      'imap.aol.com': {
        host: 'smtp.aol.com',
        port: 587,
        secure: false,
      },
      'imap.fastmail.com': {
        host: 'smtp.fastmail.com',
        port: 587,
        secure: false,
      },
    };

    const providerConfig = commonProviders[account.host];
    if (providerConfig) {
      return providerConfig;
    }

    // Default: assume SMTP server is on same host with standard ports
    return {
      host: account.host.replace('imap.', 'smtp.').replace('imap-', 'smtp-'),
      port: account.tls ? 465 : 587,
      secure: account.port === 993,
    };
  }

  /**
   * Backward-compat shim — returns just the message ID.
   * New callers should use sendEmailWithCopy() to also receive the MIME
   * bytes for an IMAP APPEND to the Sent folder.
   */
  async sendEmail(accountId: string, account: ImapAccount, email: EmailComposer): Promise<string> {
    const outcome = await this.sendEmailWithCopy(accountId, account, email);
    return outcome.messageId;
  }

  /**
   * Send the message AND return the full MIME with Bcc preserved so the
   * caller can APPEND to the IMAP Sent folder. Two-step flow:
   *   1. Build the full MIME (Bcc header included) via MailComposer.
   *   2. Hand the same mailOptions to nodemailer.sendMail — it uses Bcc
   *      for RCPT TO but strips it from DATA per RFC 5322 §3.6.3.
   */
  async sendEmailWithCopy(
    accountId: string,
    account: ImapAccount,
    email: EmailComposer
  ): Promise<SendEmailOutcome> {
    const transporter = await this.createTransporter(account);

    const mailOptions: nodemailer.SendMailOptions = {
      from: email.from || account.user,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        path: att.path,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid,
      })),
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: Array.isArray(email.references) ? email.references.join(' ') : email.references,
    };

    let rawMessage: Buffer;
    try {
      // Compile the Sent-folder copy with Bcc preserved. MailComposer's
      // underlying MimeNode strips Bcc by default (per RFC 5322 §3.6.3 for
      // the wire-protocol payload). For the *sender's* archive copy we
      // explicitly set keepBcc=true so the recipient list is preserved.
      rawMessage = await new Promise<Buffer>((resolve, reject) => {
        const composer = new MailComposer(mailOptions);
        const node = composer.compile() as any;
        node.keepBcc = true;
        node.build((err: Error | null, bytes: Buffer) => {
          if (err) reject(err);
          else resolve(bytes);
        });
      });
    } catch (e) {
      throw new Error(
        `Failed to compile MIME for Sent folder copy: ${e instanceof Error ? e.message : 'Unknown error'}`
      );
    }

    let info: nodemailer.SentMessageInfo;
    try {
      info = await transporter.sendMail(mailOptions);
    } catch (error) {
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      messageId: info.messageId,
      rawMessage,
      sentAt: new Date(),
    };
  }

  async verifySmtpConnection(account: ImapAccount): Promise<boolean> {
    try {
      const transporter = await this.createTransporter(account);
      await transporter.verify();
      return true;
    } catch (error) {
      return false;
    }
  }

  disconnect(accountId: string): void {
    const transporter = this.transporters.get(accountId);
    if (transporter) {
      transporter.close();
      this.transporters.delete(accountId);
    }
  }

  disconnectAll(): void {
    for (const [accountId, transporter] of this.transporters) {
      transporter.close();
    }
    this.transporters.clear();
  }
}