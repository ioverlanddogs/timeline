import React from 'react';
import Link from 'next/link';
import Button from './components/ui/Button';

export default function NotFound() {
  return (
    <div style={{ padding: '48px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <h2>Page not found</h2>
      <p style={{ color: 'var(--muted)', margin: '12px 0 24px' }}>
        This page doesn&apos;t exist or you may not have access.
      </p>
      <Link href="/"><Button variant="secondary">Go home</Button></Link>
    </div>
  );
}
