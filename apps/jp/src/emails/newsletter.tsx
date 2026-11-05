import { render, toPlainText } from '@react-email/render';
import React, { type ReactNode } from 'react';
import type { DigestPost } from '../lib/newsletter-model';
import { shopDesignLink } from '../lib/shop-design';

function EmailImage({
  image,
  marginTop = 16,
}: {
  image: NonNullable<DigestPost['images']>[number];
  marginTop?: number;
}) {
  const width = Math.min(image.width, 560);
  return (
    <img
      src={image.src}
      alt={image.alt}
      width={width}
      height={Math.round((image.height * width) / image.width)}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: width,
        height: 'auto',
        border: 0,
        marginTop,
      }}
    />
  );
}

function Email({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body
        style={{
          margin: 0,
          backgroundColor: '#ffffff',
          color: '#0647ff',
          fontFamily: 'Courier New, monospace',
          fontSize: 14,
          lineHeight: 1.65,
        }}
      >
        <table role="presentation" width="100%" cellPadding="0" cellSpacing="0">
          <tbody>
            <tr>
              <td style={{ padding: '32px 20px' }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding="0"
                  cellSpacing="0"
                  style={{ maxWidth: 560, margin: '0 auto' }}
                >
                  <tbody>
                    <tr>
                      <td>
                        <a
                          href="https://jp.bent.build"
                          style={{ color: '#0647ff', fontWeight: 'bold' }}
                        >
                          jp.bent.build
                        </a>
                        {children}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

export async function confirmationEmail(url: string) {
  const html = await render(
    <Email>
      <h1 style={{ fontSize: 22, fontWeight: 'normal', marginTop: 32 }}>
        confirm your email
      </h1>
      <p>
        <a
          href={url}
          style={{
            display: 'inline-block',
            backgroundColor: '#0647ff',
            color: '#ffffff',
            border: '1px solid #0647ff',
            padding: '10px 16px',
            textDecoration: 'none',
          }}
        >
          CONFIRM EMAIL
        </a>
      </p>
      <p style={{ fontSize: 12 }}>
        this link expires in 24 hours. if you didn’t sign up, you can ignore
        this email.
      </p>
    </Email>,
  );
  return { html, text: toPlainText(html) };
}

export async function digestEmail(
  posts: DigestPost[],
  unsubscribe = '{{{RESEND_UNSUBSCRIBE_URL}}}',
  test = false,
) {
  const html = await render(
    <Email>
      {test && <p>owner test email. this has not been sent to subscribers.</p>}
      {posts.map((post) => (
        <section
          key={post.id}
          style={{
            borderTop: '1px solid #0647ff',
            marginTop: 28,
            paddingTop: 16,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 'normal' }}>
            <a href={post.url} style={{ color: '#0647ff' }}>
              {post.title}
            </a>
          </h2>
          <p style={{ whiteSpace: 'pre-line' }}>{post.excerpt}</p>
          {post.images?.map((image) => (
            <EmailImage key={image.src} image={image} />
          ))}
          {post.shopDesign && (
            <a
              href={shopDesignLink(post.shopDesign)}
              style={{
                display: 'block',
                border: '1px solid #0647ff',
                marginTop: 24,
                textDecoration: 'none',
              }}
            >
              <EmailImage image={post.shopDesign.image} marginTop={0} />
              <span
                style={{
                  display: 'block',
                  backgroundColor: '#0647ff',
                  color: '#ffffff',
                  padding: '12px 16px',
                }}
              >
                SHOP DESIGN ↗
              </span>
            </a>
          )}
        </section>
      ))}
      <table
        role="presentation"
        width="100%"
        cellPadding="0"
        cellSpacing="0"
        style={{ backgroundColor: '#0647ff', marginTop: 32 }}
      >
        <tbody>
          <tr>
            <td style={{ padding: 18 }}>
              <a
                href="https://shop.bent.build/?utm_source=jp.bent.build&utm_medium=newsletter"
                style={{
                  display: 'block',
                  color: '#ffffff',
                  textDecoration: 'none',
                }}
              >
                <img
                  src="https://jp.bent.build/brand/shop-logo-email.png"
                  alt=""
                  width="24"
                  height="24"
                  style={{ verticalAlign: 'middle', marginRight: 12 }}
                />
                shop.bent.build ↗
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p
        style={{
          borderTop: '1px solid #0647ff',
          marginTop: 32,
          paddingTop: 16,
          fontSize: 12,
        }}
      >
        {test ? (
          'you are receiving this test as the blog owner.'
        ) : (
          <a href={unsubscribe} style={{ color: '#0647ff' }}>
            unsubscribe
          </a>
        )}
      </p>
    </Email>,
  );
  return { html, text: toPlainText(html) };
}
