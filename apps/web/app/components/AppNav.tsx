'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { signOut } from 'next-auth/react';
import { enableDemoTabs } from '../lib/featureFlags';

type NavChild = { href: string; label: string };

type NavGroup = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
  children?: NavChild[];
};

const baseGroups: NavGroup[] = [
  {
    label: 'Timeline',
    href: '/timeline',
    match: (p) => p.startsWith('/timeline') || p === '/',
  },
  {
    label: 'Select',
    href: '/select/drive',
    match: (p) =>
      p.startsWith('/select') ||
      p.startsWith('/drive-browser') ||
      p.startsWith('/saved-searches') ||
      p.startsWith('/saved-selections') ||
      p.startsWith('/selection-sets'),
    children: [
      { href: '/select/drive', label: 'Select from Drive' },
      { href: '/select/gmail', label: 'Select from Gmail' },
      { href: '/drive-browser', label: 'Browse Drive' },
      { href: '/saved-selections', label: 'Saved selections' },
      { href: '/saved-searches', label: 'Saved searches' },
    ],
  },
  {
    label: 'Chat',
    href: '/timeline/chat',
    match: (p) => p.startsWith('/timeline/chat') || p.startsWith('/chat'),
  },
  {
    label: 'Setup',
    href: '/getting-started',
    match: (p) =>
      p.startsWith('/getting-started') ||
      p.startsWith('/connect') ||
      p.startsWith('/calendar'),
    children: [
      { href: '/getting-started', label: 'Getting started' },
      { href: '/connect', label: 'Connect Google' },
    ],
  },
];

export default function AppNav() {
  const pathname = usePathname() ?? '/';
  const { data: session } = useSession();

  const groups = enableDemoTabs()
    ? baseGroups.map((g) =>
        g.label === 'Setup'
          ? { ...g, children: [...(g.children ?? []), { href: '/calendar', label: 'Calendar' }] }
          : g
      )
    : baseGroups;

  const initials = session?.user?.name
    ? session.user.name
        .split(' ')
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : session?.user?.email?.[0]?.toUpperCase() ?? '?';

  return (
    <nav className="app-nav" aria-label="Primary">
      {groups.map((group) => {
        const isActive = group.match(pathname);

        if (!group.children) {
          return (
            <Link key={group.href} href={group.href} data-active={isActive}>
              {group.label}
            </Link>
          );
        }

        return (
          <details key={group.href} className="nav-dropdown" open={isActive || undefined}>
            <summary data-active={isActive}>{group.label}</summary>
            <div className="nav-dropdown-panel">
              {group.children.map((child) => (
                <Link key={child.href} href={child.href}>
                  {child.label}
                </Link>
              ))}
            </div>
          </details>
        );
      })}

      <div className="nav-spacer" />

      {session ? (
        <details className="nav-dropdown nav-avatar-dropdown">
          <summary className="nav-avatar" aria-label="Account menu">
            {initials}
          </summary>
          <div className="nav-dropdown-panel nav-dropdown-panel--right">
            <span className="nav-user-email">{session.user?.email}</span>
            <button className="nav-signout" onClick={() => void signOut({ callbackUrl: '/' })}>
              Sign out
            </button>
          </div>
        </details>
      ) : null}
    </nav>
  );
}
