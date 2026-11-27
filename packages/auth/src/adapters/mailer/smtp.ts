// `Mailer` over SMTP via nodemailer — the one transport every provider offers.

import { createTransport } from "nodemailer";
import type { Mailer } from "../../ports/mailer.ts";

export interface SmtpMailerOptions {
  /** `smtp://user:pass@host:587` or `smtps://…` — nodemailer's connection URL shape. */
  url: string;
  /** The `From` header, e.g. `ryph <ryph@example.com>`. */
  from: string;
}

export function smtpMailer(opts: SmtpMailerOptions): Mailer {
  const transport = createTransport(opts.url);
  return {
    async send(mail) {
      await transport.sendMail({ from: opts.from, ...mail });
    },
  };
}
