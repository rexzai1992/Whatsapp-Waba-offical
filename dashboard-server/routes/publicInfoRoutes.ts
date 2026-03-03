import type { Express } from 'express'

export function registerPublicInfoRoutes(app: Express, ctx: any) {
    const { renderPublicInfoPage } = ctx

    app.get('/support', (_req: any, res: any) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.send(renderPublicInfoPage({
            title: 'Support',
            subtitle: 'Need help with your 2fast workspace?',
            paragraphs: [
                'Our team is here to help with onboarding, integration, and account troubleshooting.',
                'Email us at hello@2fast.xyz and include your company ID, issue summary, and screenshots if available.',
                'For urgent account access or webhook setup issues, mention your phone number ID and WABA ID in the email.'
            ]
        }))
    })

    app.get(['/privacy', '/privacy-policy'], (_req: any, res: any) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.send(renderPublicInfoPage({
            title: 'Privacy Policy',
            subtitle: 'How 2fast handles your information',
            paragraphs: [
                'We collect and process account and operational data required to provide messaging services and support.',
                'We use your data to operate the platform, secure accounts, troubleshoot issues, and improve reliability.',
                'We do not sell customer data. Access is limited to authorized personnel and service providers under confidentiality obligations.',
                'To request data corrections or privacy support, contact hello@2fast.xyz.'
            ]
        }))
    })

    app.get(['/terms', '/terms-and-conditions'], (_req: any, res: any) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.send(renderPublicInfoPage({
            title: 'Terms & Conditions',
            subtitle: 'Rules for using 2fast services',
            paragraphs: [
                'You are responsible for account credentials, user access control, and compliance with Meta and WhatsApp policies.',
                'You must not use the platform for spam, unlawful messaging, or prohibited content.',
                'Service availability may vary due to third-party dependencies including cloud providers and API platforms.',
                'For account, billing, or legal inquiries, contact hello@2fast.xyz.'
            ]
        }))
    })
}
