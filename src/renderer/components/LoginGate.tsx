import { type ReactNode,useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import type { RootState } from '../store';
import { LoginModal } from './LoginModal';

interface LoginGateProps {
  children: ReactNode;
}

export function LoginGate({ children }: LoginGateProps) {
  const { isLoggedIn, hasCompletedFirstLogin, isLoading } = useSelector(
    (s: RootState) => s.cloudAuth
  );
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const handler = () => setModalOpen(true);
    window.addEventListener('cloudAuth:openLoginModal', handler);
    return () => window.removeEventListener('cloudAuth:openLoginModal', handler);
  }, []);

  if (isLoading || hasCompletedFirstLogin === null) {
    return <div data-testid="loading">Loading…</div>;
  }

  if (!hasCompletedFirstLogin) {
    return (
      <div data-testid="first-run-screen" className="fixed inset-0 z-[80] flex items-center justify-center bg-background">
        <LoginModal isFirstRun onSuccess={() => { /* state change triggers re-render */ }} />
      </div>
    );
  }

  return (
    <>
      {children}
      {modalOpen && !isLoggedIn && (
        <LoginModal onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
