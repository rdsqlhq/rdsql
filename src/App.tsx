import React from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { ErrorBoundary } from './components/common/ErrorBoundary';

export const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <MainLayout />
    </ErrorBoundary>
  );
};

export default App;
