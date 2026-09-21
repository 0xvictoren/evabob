import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms · Evabob",
  description: "Terms for the Evabob testnet application.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="21 September 2026">
      <p>
        These terms apply to Evabob&apos;s testnet application. The product is
        provided for testing and evaluation, not as a bank account, investment
        product or promise that a transaction can be reversed. Production use
        requires final legal and regulatory review for the launch countries.
      </p>

      <LegalSection title="Eligibility and your account">
        <p>
          Use Evabob only if you may legally use the service and control the
          account, device and funds involved. Keep device authentication and
          wallet credentials private. You are responsible for reviewing the
          recipient, network, token and amount before confirming a payment.
        </p>
      </LegalSection>

      <LegalSection title="Payments and wallets">
        <p>
          Wallet functions are provided with Circle infrastructure. Blockchain
          transfers can be final and network fees, delays or failures may occur.
          Evabob will not ask for your PIN, recovery phrase, private key or full
          agent API key. Testnet assets have no guaranteed monetary value.
          Held-payment outcomes follow the rules shown before confirmation and
          may require evidence review.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>
          Do not use Evabob for unlawful activity, fraud, sanctions evasion,
          harassment, spam, unauthorized access, deceptive receipts, security
          testing without permission, or transactions involving funds you are
          not authorized to move. We may limit or suspend abusive activity to
          protect users and the service.
        </p>
      </LegalSection>

      <LegalSection title="Public and permanent information">
        <p>
          Anyone with an active public receipt link may see its limited payment
          status until the owner revokes or expires it. Public blockchain
          transactions and historical identity mappings generally cannot be
          erased. Do not submit confidential text as a blockchain transaction
          field.
        </p>
      </LegalSection>

      <LegalSection title="Availability and changes">
        <p>
          Test features may be unavailable, changed or withdrawn, including
          where a provider, network or security control requires it. We do not
          guarantee uninterrupted service. Nothing in these terms excludes
          rights or liability that cannot lawfully be excluded.
        </p>
      </LegalSection>

      <LegalSection title="Privacy, deletion and contact">
        <p>
          The Privacy notice explains data use, processors, retention and your
          rights. Account deletion cannot erase public blockchain records and
          may not remove transaction records that law requires us to retain.
          Questions may be sent to support@evabob.app.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
