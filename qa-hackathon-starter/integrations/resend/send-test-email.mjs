import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Resend } from "resend";

const recipient = (
  process.env.RESEND_TEST_TO_EMAIL ?? process.env.RESEND_TEST_RECIPIENT
)?.trim();

if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
  console.error("Set RESEND_TEST_RECIPIENT to a valid address in .env first.");
  process.exitCode = 1;
} else if (!process.env.RESEND_API_KEY) {
  console.error("Set RESEND_API_KEY in .env first.");
  process.exitCode = 1;
} else {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const confirmation = await prompt.question(
      "This sends one test email from onboarding@resend.dev to the configured recipient.\n" +
        "Type the configured recipient address exactly to approve: ",
    );

    if (confirmation.trim() !== recipient) {
      console.log("Recipient confirmation did not match; no email was sent.");
    } else {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const result = await resend.emails.send({
        from: "onboarding@resend.dev",
        to: recipient,
        subject: "QA Hackathon - Resend Integration Test",
        text: "This is an explicitly approved test of the Resend email integration.",
      });

      if (result.error !== null) {
        console.error(`Resend rejected the test email (${result.error.name}).`);
        process.exitCode = 1;
      } else {
        console.log(
          `Resend accepted the test email (provider ID: ${result.data.id}). ` +
            "This does not confirm delivery to the recipient's inbox.",
        );
      }
    }
  } catch {
    console.error("The test email could not be submitted to Resend.");
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}
