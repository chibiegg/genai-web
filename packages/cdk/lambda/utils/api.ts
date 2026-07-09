import bedrockApi from './bedrockApi';
import sagemakerApi from './sagemakerApi';
import sakuraApi from './sakuraApi';

const api = {
  bedrock: bedrockApi,
  sagemaker: sagemakerApi,
  sakura: sakuraApi,
};

export default api;
