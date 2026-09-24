import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy notice · Evabob",
  description: "How Evabob collects, uses, retains and shares personal data.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice" updated="24 September 2026">
      <p>
        This notice explains how Evabob processes personal data when you use
        the mobile app, website and testnet payment services. It is a product
        notice and should be reviewed for the countries where Evabob launches.
      </p>

      <LegalSection title="What we collect and why">
        <p>
          We process account identifiers, verified email, display name,
          handle, device/session information and security events to create and
          protect your account. We process wallet addresses, balances,
          transaction instructions, receipts and blockchain transaction hashes
          to provide payments and reconcile them. We process contacts only
          after you open the contact picker, and use selected details to help
          you find a recipient. We process chats, support messages, notification
          tokens, uploaded profile photos and evidence you choose to submit to
          deliver those features, prevent abuse and resolve held-payment
          reviews. We also process limited technical logs for reliability and
          security; tokens, API keys and free-text capability URLs must not be
          logged.
        </p>
      </LegalSection>

      <LegalSection title="Wallets, blockchain and permanence">
        <p>
          Circle provides wallet and transaction infrastructure. Public
          blockchains record wallet addresses, transaction amounts and hashes.
          Blockchain records are public and generally cannot be changed or
          erased by Evabob. Evabob does not put chat text or photo evidence
          on-chain, and held payments carry a random reference rather than
          your words. Two things can be written on-chain where the test
          network has them switched on: a note you add to a payment, which the
          send screen marks as public, and a one-way hash of your email linked
          to your wallet so money can be held for you before you join. Anyone
          who already knows your email can match that hash to your wallet, and
          neither can be erased. Your @handle is also linked to your wallet
          on-chain so people can pay it. Older identity mappings or
          transactions created before a deletion request may remain
          permanently visible on the relevant network.
        </p>
      </LegalSection>

      <LegalSection title="Service providers and international transfers">
        <p>
          Depending on enabled features, processors include Circle (wallets and
          blockchain services), Dynamic (authentication), MongoDB (application
          data), Firebase (push notifications), Pusher (real-time events), our
          hosting and email providers, and DeepSeek for the optional AI
          assistant, which is used only if you turn it on. These providers may process data in
          countries outside yours. Before production launch, Evabob must use
          appropriate processor agreements and transfer safeguards, such as
          contractual clauses, where required.
        </p>
      </LegalSection>

      <LegalSection title="AI controls">
        <p>
          The Evabob assistant uses an external model (DeepSeek) only after you
          turn it on. When it is on, your message is sent, together with the
          information needed to answer it, which can include your balance,
          recent payments, saved contacts, your email address and your wallet
          address. Earlier messages in the conversation are not sent. You can
          turn it off at any time without losing any wallet or payment
          function; with it off, the assistant still understands simple money
          commands on Evabob&apos;s own servers.
        </p>
      </LegalSection>

      <LegalSection title="Retention">
        <p>
          Chat photos are scheduled to expire after 180 days and review
          evidence after 365 days unless an active dispute or legal duty
          requires longer retention. Authentication recovery requests expire
          after their stated verification and cooling-off periods. Device push
          tokens are removed on sign-out or account deletion. Account profile,
          contacts and chats are kept while the account is active and are
          deleted or anonymized after a verified deletion request. Operational
          backups expire on the provider&apos;s backup cycle. Financial,
          fraud-prevention and transaction evidence may be retained where law
          requires it; public blockchain records remain permanently.
        </p>
      </LegalSection>

      <LegalSection title="Your choices and rights">
        <p>
          You can request access, a portable export, correction or deletion
          from the authenticated Profile screen. Sensitive requests require a
          recent sign-in. Deletion removes or anonymizes off-chain information,
          revokes public receipt links and asks relevant processors to delete
          data where supported. Some financial records must remain for legal,
          fraud-prevention or accounting reasons. You may disable detailed
          notification previews and external AI processing. Contact
          privacy@evabob.app to exercise a right, appeal a decision or ask a
          privacy question.
        </p>
      </LegalSection>

      <LegalSection title="Security and complaints">
        <p>
          Evabob uses encrypted transport, restricted media access, short-lived
          wallet sessions and device authentication. No system is completely
          secure. If you believe your account is at risk, stop using it and
          contact support. You may also complain to the data-protection
          authority that applies where you live.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
