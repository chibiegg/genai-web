import useSWR from 'swr';
import { fetchSession } from '@/lib/auth';

export const useAuth = () => {
  return useSWR('user', () => {
    return fetchSession();
  });
};
