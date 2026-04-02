const nodemailer = require('nodemailer');

// Environment variables (Set these in Vercel)
// EMAIL_USER: contato@onlyflix.sitoficial.shop
// EMAIL_PASSWORD: <your-email-password>
// SMTP_HOST: smtp.hostinger.com (default)
// SMTP_PORT: 465 (default for secure)

module.exports = async (req, res) => {
    // 1. CORS & Methods
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    try {
        const payload = req.body;
        console.log('Webhook received:', JSON.stringify(payload));

        // SyncPay usually sends the payload in 'data' or directly.
        // Let's handle both.
        const data = payload.data || payload;
        const status = data.status; // 'completed', 'paid', 'approved'
        const clientEmail = data.client ? data.client.email : (data.email || null);

        // Check for paid status (adjust based on exact SyncPay enum)
        if (status === 'completed' || status === 'paid' || status === 'approved') {

            if (!clientEmail) {
                console.warn('No email found in webhook payload');
                res.status(200).json({ message: 'No email to send' });
                return;
            }

            console.log(`Payment confirmed for ${clientEmail}. Sending email...`);

            // 2. Configure Transporter
            const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || 'smtp.hostinger.com',
                port: parseInt(process.env.SMTP_PORT || '465'),
                secure: true, // true for 465, false for 587
                auth: {
                    user: process.env.EMAIL_USER || 'contato@onlyflix.sitoficial.shop',
                    pass: 'Tor020704.'
                }
            });

            // 3. Email Content
            const mailOptions = {
                from: `"OnlyFlix Premium" <${process.env.EMAIL_USER || 'contato@onlyflix.sitoficial.shop'}>`,
                to: clientEmail,
                subject: 'Sua Assinatura OnlyFlix foi Confirmada! 🚀',
                html: `
                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
                        <div style="background-color: #E60000; padding: 20px; text-align: center;">
                            <h1 style="color: white; margin: 0;">OnlyFlix Premium</h1>
                        </div>
                        <div style="padding: 20px; border: 1px solid #ddd; border-top: none;">
                            <h2 style="color: #E60000;">Pagamento Confirmado!</h2>
                            <p>Olá,</p>
                            <p>Seu pagamento foi aprovado com sucesso e seu acesso ao conteúdo exclusivo já está liberado.</p>
                            
                            <div style="background-color: #f9f9f9; padding: 15px; margin: 20px 0; border-left: 4px solid #E60000;">
                                <p style="margin: 0; font-weight: bold;">Clique no botão abaixo para acessar:</p>
                                <br>
                                <a href="https://mbmsonlyflixv1.vercel.app/" style="background-color: #E60000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">ACESSAR AGORA</a>
                            </div>

                            <p>Se o botão não funcionar, copie e cole o link abaixo no seu navegador:</p>
                            <p><a href="https://mbmsonlyflixv1.vercel.app/" style="color: #E60000;">https://mbmsonlyflixv1.vercel.app/</a></p>
                            
                            <p>Atenciosamente,<br>Equipe OnlyFlix</p>
                        </div>
                        <div style="text-align: center; font-size: 12px; color: #999; padding: 10px;">
                            © 2024 OnlyFlix. Todos os direitos reservados.
                        </div>
                    </div>
                `
            };

            // 4. Send
            await transporter.sendMail(mailOptions);
            console.log('Email sent successfully');
        }

        res.status(200).json({ received: true });

    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).json({ error: err.message });
    }
};
