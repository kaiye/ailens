import { AICodeItem } from '../core/types';

export interface AIProvider {
  id: string;
  start(onItems: (items: AICodeItem[]) => void): Promise<void> | void;
  stop(): void;
  getStatus?(): Promise<any> | any;
}

