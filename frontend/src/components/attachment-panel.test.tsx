import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BASE_URL } from '../api/client';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { AttachmentPanel } from './attachment-panel';

/**
 * Attachment panel tests (docs/37 §2, docs/19 §7, docs/16).
 *
 * What matters here is what the UI is responsible for: showing only what the server
 * called available, stating a rejection cause and a remedy, and holding the client-side
 * size check as UX rather than as a control — the upload function is still expected to
 * be refused by the server if it were called directly.
 */

const uploadAttachment = vi.fn();

vi.mock('../api/attachments.api', async () => {
  const actual =
    await vi.importActual<typeof import('../api/attachments.api')>('../api/attachments.api');
  return {
    ...actual,
    listAttachments: async () => ({
      items: [
        {
          id: 'att-1',
          filename: 'screen.png',
          contentType: 'image/png',
          sizeBytes: 2048,
          status: 'AVAILABLE',
          uploadedBy: { id: 'u-1', displayName: 'Alice Requester' },
          createdAt: '2026-10-09T10:00:00.000Z',
          downloadUrl: '/api/v1/attachments/att-1/content',
        },
      ],
    }),
    uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
  };
});

function renderPanel(props: { canUpload?: boolean } = {}) {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Alice Requester',
      email: 'alice@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: [],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: () => true,
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <AttachmentPanel
          entityType="ServiceRequest"
          entityId="req-1"
          canUpload={props.canUpload ?? true}
        />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('AttachmentPanel', () => {
  it('lists an available file with its uploader and a download link', async () => {
    renderPanel();

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB · Alice Requester/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', `${BASE_URL}/attachments/att-1/content`);
  });

  it('states a cause and a remedy when the file exceeds the cap (docs/16)', async () => {
    const user = userEvent.setup();
    renderPanel();

    const input = screen.getByLabelText('Choose a file to attach');
    const oversized = new File([new ArrayBuffer(10 * 1024 * 1024 + 1)], 'huge.bin');
    await user.upload(input, oversized);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(
      await screen.findByText('Attachment exceeds 10 MB. Choose a smaller file.'),
    ).toBeInTheDocument();
    // UX only — the request is never sent, and the server enforces the same cap.
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('uploads a file within the cap through the API', async () => {
    uploadAttachment.mockResolvedValue({
      attachment: { id: 'att-2', filename: 'note.txt' },
    });

    const user = userEvent.setup();
    renderPanel();

    const input = screen.getByLabelText('Choose a file to attach');
    await user.upload(input, new File(['hello'], 'note.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await vi.waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(uploadAttachment.mock.calls[0]?.[0]).toBe('ServiceRequest');
    expect(uploadAttachment.mock.calls[0]?.[1]).toBe('req-1');
  });

  it('hides the upload form when the caller may not attempt one', async () => {
    renderPanel({ canUpload: false });
    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });
});
