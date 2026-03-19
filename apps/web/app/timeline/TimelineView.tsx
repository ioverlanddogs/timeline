'use client';

import Link from 'next/link';
import React, { useEffect } from 'react';

import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import {
  groupTimelineArtifacts,
  sourceTypeLabel,
  timelineCardTitle,
  toBullets,
} from '../lib/timeline/exportBuilder';
import type { SummaryArtifact } from '../lib/types';
import styles from './timelineView.module.css';

type TimelineArtifact = {
  entryKey: string;
  artifact: SummaryArtifact;
};

type TimelineViewProps = {
  artifacts: TimelineArtifact[];
  highlightedArtifactId?: string | null;
  onSelectArtifact?: (artifactId: string) => void;
};

export default function TimelineView({ artifacts, highlightedArtifactId, onSelectArtifact }: TimelineViewProps) {
  const groups = groupTimelineArtifacts(artifacts);

  useEffect(() => {
    if (!highlightedArtifactId) return;
    const target = document.querySelector(`[data-artifact-id="${highlightedArtifactId}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedArtifactId]);

  if (!artifacts.length) {
    return (
      <Card className={styles.emptyState}>
        <h2>No summaries yet</h2>
        <p>Select a few documents from Drive or Gmail, then summarise them to build your timeline.</p>
        <Link href="/select/drive">
          <Button variant="primary">Select from Drive</Button>
        </Link>
        <p className={styles.emptyStateSecondary}>
          New here?{' '}
          <Link href="/getting-started">View the setup guide</Link>
        </p>
      </Card>
    );
  }

  return (
    <div className={styles.timeline}>
      {groups.map((group) => (
        <section key={group.key} className={styles.group}>
          <h3 className={styles.groupHeader}>{group.label}</h3>
          {group.key === 'undated' ? (
            <p className={styles.undatedHelp}>No clear date detected in source.</p>
          ) : null}
          <div className={styles.items}>
            {group.artifacts.map(({ entryKey, artifact }) => {
              const title = timelineCardTitle(artifact);
              const bullets = toBullets(artifact);
              const participants = artifact.participants?.join(', ');
              const entities = artifact.entities?.map((entity) => entity.name).join(', ');
              const annotatedEntities = artifact.userAnnotations?.entities?.join(', ');
              const people = participants || entities || annotatedEntities;
              const location = artifact.userAnnotations?.location;
              const amount = artifact.userAnnotations?.amount;
              const externalLink = artifact.driveWebViewLink || `https://drive.google.com/file/d/${artifact.driveFileId}/view`;
              const internalLink = `/timeline?artifactId=${encodeURIComponent(artifact.driveFileId)}`;
              const isHighlighted =
                highlightedArtifactId === artifact.driveFileId ||
                highlightedArtifactId === artifact.artifactId;
              const entryDate = artifact.contentDateISO ? new Date(artifact.contentDateISO) : null;
              const dayNum = entryDate ? entryDate.getDate() : null;
              const weekday = entryDate
                ? entryDate.toLocaleDateString('en-GB', { weekday: 'short' })
                : null;

              return (
                <div key={artifact.artifactId} className={styles.entry}>
                  <div className={styles.entryDate}>
                    {dayNum ? (
                      <span className={styles.entryDay}>{dayNum}</span>
                    ) : (
                      <span className={styles.entryDayBlank}>—</span>
                    )}
                    {weekday ? <span className={styles.entryWeekday}>{weekday}</span> : null}
                  </div>
                  <Card
                    className={`${styles.item} ${isHighlighted ? styles.highlighted : ''}`.trim()}
                    data-entry-key={entryKey}
                    data-artifact-id={artifact.driveFileId}
                    onClick={(event) => {
                      const target = event.target as HTMLElement;
                      if (target.closest('a,button,input,textarea,select')) {
                        return;
                      }
                      onSelectArtifact?.(artifact.driveFileId);
                    }}
                  >
                    <h4 className={styles.itemTitle}>{title}</h4>
                    <ul className={styles.bullets}>
                      {bullets.map((line, index) => (
                        <li key={`${artifact.artifactId}-line-${index}`}>{line}</li>
                      ))}
                    </ul>
                    <div className={styles.metaRow}>
                      <span>{sourceTypeLabel(artifact)}</span>
                      {people ? <span>• {people}</span> : null}
                      {location ? <span>• {location}</span> : null}
                      {amount ? <span>• {amount}</span> : null}
                      <a href={externalLink} target="_blank" rel="noreferrer">
                        View source
                      </a>
                      <Link href={internalLink}>Jump to summary</Link>
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export { groupTimelineArtifacts };
