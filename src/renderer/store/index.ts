import { configureStore } from '@reduxjs/toolkit';

import agentReducer from './slices/agentSlice';
import cloudAuthReducer from './slices/cloudAuthSlice';
import coworkReducer from './slices/coworkSlice';
import imReducer from './slices/imSlice';
import mcpReducer from './slices/mcpSlice';
import modelReducer from './slices/modelSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import skillReducer from './slices/skillSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
    cloudAuth: cloudAuthReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
