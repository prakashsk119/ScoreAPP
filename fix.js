const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const targetBlock = `
    // 1. Send via Real Email if it's an email address
    if (isEmail) {
      if (!mailTransporter) {
        console.warn(\`[AUTH] Email OTP requested for \${rawId} but mailTransporter is not configured. Falling back to mock mode.\`);
      } else {
        try {
          await mailTransporter.sendMail({
            from: \`"CricScore App" <\${EMAIL_USER}>\`,
            to: rawId,
            subject: \`CricScore Login OTP: \${otpCode}\`,
            text: \`Your CricScore login OTP code is \${otpCode}. Valid for 10 minutes. Do not share this code with anyone.\`,
            html: \`
              <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #cbd5e1; border-radius: 16px; background-color: #ffffff;">
                <div style="text-align: center; margin-bottom: 20px;">
                  <h1 style="color: #00a896; margin: 0; font-size: 26px; font-weight: 800;">CricScore</h1>
                  <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Live Ball-by-Ball Cricket Scoring</p>
                </div>
                <div style="background-color: #f8fafc; border-radius: 12px; padding: 24px; text-align: center; border: 1px solid #e2e8f0; margin-bottom: 20px;">
                  <p style="color: #475569; font-size: 14px; margin-bottom: 12px; font-weight: 600;">Your One-Time Password (OTP) for Login:</p>
                  <div style="font-size: 34px; font-weight: 900; letter-spacing: 6px; color: #0284c7; background: #ffffff; padding: 12px 20px; border-radius: 10px; border: 2px dashed #0284c7; display: inline-block; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.15);">
                    \${otpCode}
                  </div>
                  <p style="color: #94a3b8; font-size: 12px; margin-top: 14px; margin-bottom: 0;">This OTP code is valid for 10 minutes. Do not share this code.</p>
                </div>
                <p style="color: #94a3b8; font-size: 11px; text-align: center;">If you did not request this OTP, please ignore this email.</p>
              </div>
            \`
          });
          console.log(\`[AUTH] Real email OTP sent to \${rawId}\`);
          return res.json({
            success: true,
            message: \`OTP email sent successfully to \${rawId}! Check your inbox.\`,
            realEmail: true
          });
        } catch (mailErr) {
          console.error('❌ Nodemailer email error:', mailErr.message);
          return res.status(400).json({
            error: 'Unable to send OTP. Please try again.'
          });
        }
      }
    }
`;

const startIndex = code.indexOf("// 1. Send via Real Email if it's an email address");
const endIndex = code.indexOf("// 2. Send via Twilio SMS");

if (startIndex !== -1 && endIndex !== -1) {
  code = code.substring(0, startIndex) + targetBlock + '\n    ' + code.substring(endIndex);
  fs.writeFileSync('server.js', code);
  console.log("Success");
} else {
  console.log("Failed to find boundaries");
}
