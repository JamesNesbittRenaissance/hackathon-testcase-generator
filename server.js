const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const azdev = require('azure-devops-node-api');
const { WorkItemExpand } = require('azure-devops-node-api/interfaces/WorkItemTrackingInterfaces');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { fromIni } = require('@aws-sdk/credential-provider-ini');
const PBIQualityAssessor = require('./pbi-quality-assessor');

const app = express();
const PORT = 3000;

// Check if Angular build exists
const distPath = path.join(__dirname, 'dist/pbi-pr-analyzer/browser/index.html');
if (!fs.existsSync(distPath)) {
  console.error('');
  console.error('============================================');
  console.error('  ERROR: Angular build not found!');
  console.error('============================================');
  console.error('');
  console.error('The Angular application has not been built yet.');
  console.error('');
  console.error('Please run: npm run build');
  console.error('');
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const DEFAULT_ORG = 'https://dev.azure.com/gl-development';
const DEFAULT_PROJECT = 'Testwise';
const AZURE_DEVOPS_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_PROFILE = process.env.AWS_PROFILE || 'ai-tools-prod';
const BEDROCK_MODEL_ID = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'us.anthropic.claude-opus-4-6-v1';

// Azure token cache with TTL
let azureTokenCache = {
  token: null,
  expiresAt: 0
};

// Helper function to get Azure CLI access token with caching
async function getAzureToken() {
  const now = Date.now();

  // Return cached token if still valid (with 5min buffer before expiry)
  if (azureTokenCache.token && azureTokenCache.expiresAt > now + 300000) {
    console.log('✓ Using cached Azure token');
    return azureTokenCache.token;
  }

  // Refresh token
  try {
    console.log('🔄 Fetching new Azure token...');
    const { stdout } = await execAsync(
      `az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID}`,
      {
        encoding: 'utf-8',
        timeout: 10000
      }
    );
    const tokenData = JSON.parse(stdout);
    azureTokenCache.token = tokenData.accessToken;
    azureTokenCache.expiresAt = now + 3600000; // 1 hour TTL
    console.log('✓ Azure token cached');
    return azureTokenCache.token;
  } catch (error) {
    throw new Error('Azure CLI not logged in. Please run "az login" first.');
  }
}

// Synchronous version for backward compatibility (uses cache if available)
function getAzureTokenSync() {
  if (azureTokenCache.token && azureTokenCache.expiresAt > Date.now() + 300000) {
    return azureTokenCache.token;
  }

  // Fallback to sync call if no cache
  try {
    const result = execSync(`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID}`, {
      encoding: 'utf-8',
      timeout: 10000
    });
    const tokenData = JSON.parse(result);
    azureTokenCache.token = tokenData.accessToken;
    azureTokenCache.expiresAt = Date.now() + 3600000;
    return tokenData.accessToken;
  } catch (error) {
    throw new Error('Azure CLI not logged in. Please run "az login" first.');
  }
}

// Helper function to get Bedrock client
function getBedrockClient() {
  try {
    const client = new BedrockRuntimeClient({
      region: AWS_REGION,
      credentials: fromIni({ profile: AWS_PROFILE })
    });
    return client;
  } catch (error) {
    throw new Error('Failed to create Bedrock client. Ensure AWS credentials are configured.');
  }
}

// Helper function to call Claude via Bedrock
async function invokeClaudeOnBedrock(prompt) {
  const client = getBedrockClient();

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16384, // Increased from 4096 to allow for comprehensive test plans
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  };

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload)
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.content[0].text;
}

// Check Azure CLI authentication status
function checkAzureCliAuth() {
  try {
    execSync('az account show', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// HELPER FUNCTIONS FOR TEST CASE EXPORT
// ============================================================================

/**
 * Escape XML special characters for DevOps test steps
 */
function escapeXml(text) {
  if (!text) return '';

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, ' ') // Replace newlines with spaces
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
}

/**
 * Generate DevOps test steps XML format
 */
function generateDevOpsStepsXml(steps) {
  if (!steps || steps.length === 0) {
    return '<steps id="0" last="0"></steps>';
  }

  const stepElements = steps.map((step, index) => {
    const stepId = index + 1;
    const action = escapeXml(step.action || 'No action specified');
    const expected = escapeXml(step.expected || 'No expected result specified');

    return `  <step id="${stepId}" type="ActionStep">
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${action}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${expected}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <description/>
  </step>`;
  }).join('\n');

  return `<steps id="0" last="${steps.length}">
${stepElements}
</steps>`;
}

/**
 * Parse Given/When/Then format
 */
function parseGivenWhenThen(content) {
  const steps = [];
  let description = '';

  // Extract Given (preconditions)
  const givenMatch = content.match(/\*\*Given:\*\*\s*(.+?)(?=\n\*\*When:|\n\*\*Then:|$)/s);
  const given = givenMatch ? givenMatch[1].trim() : '';

  // Extract When (action)
  const whenMatch = content.match(/\*\*When:\*\*\s*(.+?)(?=\n\*\*Then:|\n\*\*Given:|$)/s);
  const when = whenMatch ? whenMatch[1].trim() : '';

  // Extract Then (expected result)
  const thenMatch = content.match(/\*\*Then:\*\*\s*(.+?)(?=\n\*\*When:|\n\*\*Given:|\n##|$)/s);
  const then = thenMatch ? thenMatch[1].trim() : '';

  // Extract any content before Given/When/Then as description
  const descMatch = content.match(/^([\s\S]+?)(?=\*\*Given:|\*\*When:|\*\*Then:)/);
  if (descMatch) {
    description = descMatch[1].trim();
  }

  // Create steps
  if (given) {
    steps.push({
      action: `Precondition: ${given}`,
      expected: 'Setup complete'
    });
  }

  if (when && then) {
    steps.push({
      action: when,
      expected: then
    });
  } else if (when) {
    steps.push({
      action: when,
      expected: 'See description'
    });
  }

  return { steps, description };
}

/**
 * Parse numbered or bulleted list format
 */
function parseListSteps(content) {
  const steps = [];
  let description = '';

  // Extract any content before first list item as description
  const descMatch = content.match(/^([\s\S]+?)(?=^\d+\.\s+|^[-*]\s+)/m);
  if (descMatch) {
    description = descMatch[1].trim();
  }

  // Match list items (numbered or bulleted)
  const listItemRegex = /^(?:\d+\.|\-|\*)\s+(.+?)$/gm;
  let match;

  while ((match = listItemRegex.exec(content)) !== null) {
    const itemText = match[1].trim();

    // Try to split into action/expected if there's an indicator
    const expectedIndicators = ['Expected:', 'Result:', 'Verify:', 'Should:', 'Then:'];
    let action = itemText;
    let expected = 'Verify step completes successfully';

    for (const indicator of expectedIndicators) {
      if (itemText.includes(indicator)) {
        const parts = itemText.split(indicator);
        action = parts[0].trim();
        expected = parts[1].trim();
        break;
      }
    }

    steps.push({ action, expected });
  }

  return { steps, description };
}

/**
 * Parse test case content into structured format
 * Handles multiple content structures
 */
function parseTestCaseContent(content, testCaseId) {
  // Try to detect format
  const hasGivenWhenThen = content.includes('**Given:**') || content.includes('**When:**') || content.includes('**Then:**');
  const hasNumberedSteps = /^\d+\.\s+/m.test(content);
  const hasBulletSteps = /^[-*]\s+/m.test(content);

  let steps = [];
  let description = '';

  if (hasGivenWhenThen) {
    // Parse Given/When/Then format
    const result = parseGivenWhenThen(content);
    steps = result.steps;
    description = result.description;
  } else if (hasNumberedSteps || hasBulletSteps) {
    // Parse list-based format
    const result = parseListSteps(content);
    steps = result.steps;
    description = result.description;
  } else {
    // Freeform text - treat entire content as description with single step
    description = content;
    steps = [{
      action: 'Execute test case as described',
      expected: 'See description for expected results'
    }];
  }

  // Convert to DevOps XML format
  const stepsXml = generateDevOpsStepsXml(steps);

  return {
    description: description || `Test case ${testCaseId}`,
    stepsXml: stepsXml
  };
}

/**
 * Parse test cases from markdown - FORMAT AGNOSTIC
 *
 * Works with:
 * - Given/When/Then format
 * - Numbered steps
 * - Bulleted lists
 * - Freeform text
 * - Mixed formats
 */
function parseTestCasesFromMarkdown(markdown) {
  const testCases = [];

  // Match test case headers - flexible patterns
  // Matches: "## TC-001: Title", "### TC-001: Title", "## Test Case 1: Title", etc.
  const headerRegex = /^(#{2,3})\s+(TC-\d+|Test Case \d+):\s*(.+?)$/gm;

  let matches = [];
  let match;

  // Find all test case headers and their positions
  while ((match = headerRegex.exec(markdown)) !== null) {
    matches.push({
      fullMatch: match[0],
      headerLevel: match[1],
      id: match[2],
      title: match[3].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }

  if (matches.length === 0) {
    console.warn('No test case headers found. Expected format: ## TC-001: Title');
    return [];
  }

  // Extract content between headers
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];

    // Content is from end of current header to start of next header (or end of string)
    const contentStart = current.endIndex;
    const contentEnd = next ? next.startIndex : markdown.length;
    const rawContent = markdown.substring(contentStart, contentEnd).trim();

    if (!rawContent) {
      console.warn(`Test case ${current.id} has no content, skipping`);
      continue;
    }

    // Parse content into structured format
    const parsedContent = parseTestCaseContent(rawContent, current.id);

    testCases.push({
      id: current.id,
      title: `${current.id}: ${current.title}`,
      description: parsedContent.description,
      steps: parsedContent.stepsXml,
      rawContent: rawContent // Preserve for debugging
    });
  }

  console.log(`Parsed ${testCases.length} test case(s) from markdown`);
  return testCases;
}

/**
 * Helper to flatten classification node tree (area paths, iterations)
 */
function flattenClassificationTree(node, prefix = '') {
  const currentPath = prefix ? `${prefix}\\${node.name}` : node.name;
  let paths = [currentPath];

  if (node.children && node.children.length > 0) {
    node.children.forEach(child => {
      paths = paths.concat(flattenClassificationTree(child, currentPath));
    });
  }

  return paths;
}

// API Routes

// Get settings/status
app.get('/api/settings', (req, res) => {
  res.json({
    azureDevOpsOrg: DEFAULT_ORG,
    defaultProject: DEFAULT_PROJECT,
    defaultRepository: '',
    azureCliAuthenticated: checkAzureCliAuth(),
    claudeApiKeySource: 'bedrock',
    awsRegion: AWS_REGION,
    awsProfile: AWS_PROFILE,
    bedrockModelId: BEDROCK_MODEL_ID
  });
});

// Get Work Item
app.get('/api/workitem/:id', async (req, res) => {
  try {
    const workItemId = parseInt(req.params.id);
    const project = req.query.project || DEFAULT_PROJECT;

    console.log(`Fetching work item ${workItemId} from project ${project}...`);

    // Sanity check: Azure DevOps work item IDs must fit in Int32 (max 2147483647)
    // Also check for obviously invalid values
    if (workItemId > 2147483647 || workItemId < 1 || isNaN(workItemId)) {
      console.error(`✗ Invalid work item ID: ${req.params.id} (parsed as ${workItemId})`);
      return res.status(404).json({
        success: false,
        error: `Work item ${req.params.id} is not a valid work item ID. Work item IDs must be positive integers less than 2,147,483,647.`,
        validationError: true
      });
    }

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const witApi = await connection.getWorkItemTrackingApi(project);

    // getWorkItem(id, fields, asOf, expand)
    // Only fetch fields we actually use (performance optimization)
    const workItem = await witApi.getWorkItem(
      workItemId,
      [
        'System.Title',
        'System.Description',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'System.State',
        'System.WorkItemType',
        'System.AssignedTo'
      ],
      undefined, // asOf
      WorkItemExpand.None // Don't expand relations/links (performance optimization)
    );

    // Validate the work item response
    if (!workItem) {
      console.error(`Work item ${workItemId} returned null/undefined`);
      return res.status(404).json({
        success: false,
        error: `Work item ${workItemId} not found. This could mean: (1) The ticket doesn't exist, (2) You don't have permission to view it, or (3) It's in a different project than '${project}'.`,
        validationError: true
      });
    }

    // Check for permissions/access issues - empty fields object is a telltale sign
    if (!workItem.fields || Object.keys(workItem.fields).length === 0) {
      console.error(`Work item ${workItemId} has no fields - likely a permissions issue`);
      return res.status(403).json({
        success: false,
        error: `Unable to access work item ${workItemId}. You may not have permission to view this item or it may not exist in the specified project.`,
        validationError: true
      });
    }

    // Validate essential fields exist
    const hasTitle = workItem.fields['System.Title'];
    const hasWorkItemType = workItem.fields['System.WorkItemType'];

    if (!hasTitle || !hasWorkItemType) {
      console.error(`Work item ${workItemId} missing essential fields (Title: ${!!hasTitle}, Type: ${!!hasWorkItemType})`);
      return res.status(403).json({
        success: false,
        error: `Work item ${workItemId} appears incomplete. This usually indicates insufficient permissions or the item doesn't exist.`,
        validationError: true
      });
    }

    console.log(`✓ Successfully fetched work item ${workItemId}: "${workItem.fields['System.Title']}"`);
    res.json({ success: true, data: workItem });
  } catch (error) {
    console.error(`Error fetching work item ${req.params.id}:`, error);
    console.error('Error type:', typeof error);
    console.error('Error properties:', Object.keys(error));

    // Log more details about the error structure for debugging
    if (error.statusCode) console.error('Error statusCode:', error.statusCode);
    if (error.status) console.error('Error status:', error.status);
    if (error.code) console.error('Error code:', error.code);

    console.error('Error stack:', error.stack);

    // Check if this is a 404 error from Azure DevOps (multiple ways to detect)
    const is404 =
      error.statusCode === 404 ||
      error.status === 404 ||
      error.code === 404 ||
      (error.message && (
        error.message.includes('404') ||
        error.message.includes('does not exist') ||
        error.message.toLowerCase().includes('not found') ||
        error.message.includes('Work item') && error.message.includes('does not exist')
      ));

    if (is404) {
      console.error('✗ Detected 404: Work item not found');
      return res.status(404).json({
        success: false,
        error: `Work item ${req.params.id} not found. This could mean: (1) The ticket doesn't exist, (2) You don't have permission to view it, or (3) It's in a different project than '${req.query.project || DEFAULT_PROJECT}'.`,
        validationError: true
      });
    }

    // Check if this is an authentication/authorization error
    const isAuthError =
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      error.status === 401 ||
      error.status === 403 ||
      (error.message && (
        error.message.includes('unauthorized') ||
        error.message.includes('forbidden') ||
        error.message.includes('Access denied') ||
        error.message.includes('authentication')
      ));

    if (isAuthError) {
      console.error('✗ Detected auth error: Access denied');
      return res.status(403).json({
        success: false,
        error: `Access denied for work item ${req.params.id}. Please check your Azure DevOps permissions and PAT token.`,
        validationError: true
      });
    }

    // Check if this is a 400 Bad Request (invalid work item ID format)
    const is400BadRequest =
      error.statusCode === 400 ||
      error.status === 400 ||
      (error.message && (
        error.message.includes('parameter conversion') ||
        error.message.includes('System.Int32') ||
        error.message.includes('BadRequest')
      )) ||
      (error.result && error.result.value && error.result.value.Message && (
        error.result.value.Message.includes('parameter conversion') ||
        error.result.value.Message.includes('System.Int32')
      ));

    if (is400BadRequest) {
      console.error('✗ Detected 400 Bad Request: Invalid work item ID format');
      return res.status(404).json({
        success: false,
        error: `Work item ${req.params.id} is not a valid work item ID. Please check the ID and try again.`,
        validationError: true
      });
    }

    // Generic error
    console.error('✗ Unhandled error type, returning 500');
    res.status(500).json({
      success: false,
      error: error.message || 'An error occurred while fetching the work item',
      details: `Error type: ${typeof error}, Status: ${error.statusCode || error.status || 'unknown'}`,
      stack: error.stack
    });
  }
});

// Analyze with Claude
app.post('/api/analyze', async (req, res) => {
  try {
    const { data, analysisType, userFeedback, previousTestCases, additionalContext, generateAll } = req.body;

    // Set up SSE headers for streaming progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in nginx

    // Helper function to send SSE messages
    const sendProgress = (message) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', message })}\n\n`);
      console.log(`  📤 Sent progress: ${message}`);
    };

    console.log('');
    console.log('============================================');
    console.log(`  Starting Analysis: ${analysisType}`);
    console.log('============================================');

    // Build request context once to avoid duplicate loading
    console.time('⏱️  Request Context Load');
    const requestContext = buildRequestContext();
    console.timeEnd('⏱️  Request Context Load');

    if (analysisType === 'testCases') {
      // Log generation mode
      if (generateAll) {
        console.log('📋 Generating ALL test cases (comprehensive mode)');
      } else {
        console.log('📋 Generating Happy Path + Top 5 Critical tests (focused mode)');
      }

      // Log additional context if provided
      if (additionalContext) {
        console.log('📝 Additional Context from PBI Quality Assessment:');
        console.log(`   ${additionalContext.substring(0, 150).replace(/\n/g, '\n   ')}${additionalContext.length > 150 ? '...' : ''}`);
      } else {
        console.log('ℹ No additional context provided from PBI Quality Assessment');
      }

      // If user provided feedback, use direct improvement flow
      if (userFeedback && previousTestCases) {
        console.log('🔄 User Feedback Mode - Improving existing test cases...');
        console.log(`   Feedback: "${userFeedback.substring(0, 100)}${userFeedback.length > 100 ? '...' : ''}"`);
        sendProgress('Regenerating with feedback');
        const result = await improveTestCasesWithFeedback(data, previousTestCases, userFeedback, additionalContext, sendProgress, requestContext, generateAll);

        res.write(`data: ${JSON.stringify({
          type: 'complete',
          success: true,
          data: result.testCases,
          qualityScore: result.qualityScore,
          iterations: 1
        })}\n\n`);
        res.end();
      } else {
        // Use iterative quality generation for initial test cases
        const result = await generateTestCasesWithQuality(data, additionalContext, sendProgress, requestContext, generateAll);

        res.write(`data: ${JSON.stringify({
          type: 'complete',
          success: true,
          data: result.testCases,
          qualityScore: result.qualityScore,
          iterations: result.iterations
        })}\n\n`);
        res.end();
      }
    } else if (analysisType === 'pbiQualityAssessment') {
      // PBI Quality Assessment using specialized assessor
      console.log('📊 Using PBI Quality Assessor with rich system prompt and examples...');
      sendProgress('Analyzing PBI quality');
      const assessor = new PBIQualityAssessor(requestContext);
      const payload = assessor.buildBedrockPayload(data);

      const client = getBedrockClient();
      const command = new InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload)
      });

      console.log(`🤖 Calling Claude via AWS Bedrock (${BEDROCK_MODEL_ID})...`);
      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const result = responseBody.content[0].text;

      console.log('✓ Claude response received from Bedrock');
      console.log('============================================');
      console.log('');

      res.write(`data: ${JSON.stringify({
        type: 'complete',
        success: true,
        data: result
      })}\n\n`);
      res.end();
    } else {
      // Other analysis types use simple generation
      let prompt = '';
      let progressMsg = '';
      switch (analysisType) {
        case 'impactAnalysis':
          prompt = buildImpactAnalysisPrompt(data);
          progressMsg = 'Analyzing impact';
          break;
        case 'documentation':
          prompt = buildDocumentationPrompt(data);
          progressMsg = 'Generating documentation';
          break;
        default:
          throw new Error(`Unknown analysis type: ${analysisType}`);
      }

      console.log(`🤖 Calling Claude via AWS Bedrock (${BEDROCK_MODEL_ID})...`);
      sendProgress(progressMsg);

      const result = await invokeClaudeOnBedrock(prompt);

      console.log('✓ Claude response received from Bedrock');
      console.log('============================================');
      console.log('');

      res.write(`data: ${JSON.stringify({
        type: 'complete',
        success: true,
        data: result
      })}\n\n`);
      res.end();
    }
  } catch (error) {
    console.error('Error in Claude analysis:', error);
    console.error('Error stack:', error.stack);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      success: false,
      error: error.message,
      details: error.toString()
    })}\n\n`);
    res.end();
  }
});

// ============================================================================
// AZURE DEVOPS TEST PLANS API ENDPOINTS
// ============================================================================

/**
 * GET /api/project-info - Get project structure (area paths, iterations)
 * Used to populate dropdowns for creating new test plans
 */
app.get('/api/project-info', async (req, res) => {
  try {
    const { project } = req.query;
    const projectName = project || DEFAULT_PROJECT;

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const witApi = await connection.getWorkItemTrackingApi();
    const coreApi = await connection.getCoreApi();

    // Get project details
    const projectDetails = await coreApi.getProject(projectName);

    // Get area paths - with fallback
    let areaPaths = [projectName];
    try {
      const areaTree = await witApi.getClassificationNode(
        projectName,
        'Areas',
        undefined,
        10 // depth
      );
      areaPaths = flattenClassificationTree(areaTree);
    } catch (areaError) {
      console.warn('Could not fetch area paths, using default:', areaError.message);
    }

    // Get iteration paths - with fallback
    let iterationPaths = [projectName];
    try {
      const iterationTree = await witApi.getClassificationNode(
        projectName,
        'Iterations',
        undefined,
        10 // depth
      );
      iterationPaths = flattenClassificationTree(iterationTree);
    } catch (iterationError) {
      console.warn('Could not fetch iteration paths, using default:', iterationError.message);
    }

    res.json({
      success: true,
      data: {
        projectName: projectDetails.name,
        areaPaths: areaPaths,
        iterationPaths: iterationPaths,
        defaultAreaPath: projectName,
        defaultIteration: projectName
      }
    });
  } catch (error) {
    console.error('Error fetching project info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/test-plans - Get all test plans for a project
 */
app.get('/api/test-plans', async (req, res) => {
  try {
    const { project } = req.query;
    const projectName = project || DEFAULT_PROJECT;

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const testPlanApi = await connection.getTestPlanApi();

    const testPlans = await testPlanApi.getTestPlans(projectName);

    res.json({
      success: true,
      data: testPlans.map(plan => ({
        id: plan.id,
        name: plan.name,
        state: plan.state,
        iteration: plan.iteration,
        areaPath: plan.areaPath,
        rootSuite: plan.rootSuite ? {
          id: plan.rootSuite.id,
          name: plan.rootSuite.name
        } : null
      }))
    });
  } catch (error) {
    console.error('Error fetching test plans:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/test-suites - Get test suites for a test plan
 */
app.get('/api/test-suites', async (req, res) => {
  try {
    const { project, planId } = req.query;
    const projectName = project || DEFAULT_PROJECT;

    if (!planId) {
      return res.status(400).json({
        success: false,
        error: 'planId is required'
      });
    }

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const testPlanApi = await connection.getTestPlanApi();

    // Get test plan to find root suite
    const plan = await testPlanApi.getTestPlanById(projectName, parseInt(planId));

    // Get all suites for the plan
    const suites = await testPlanApi.getTestSuitesForPlan(projectName, parseInt(planId));

    res.json({
      success: true,
      data: {
        rootSuiteId: plan.rootSuite?.id,
        suites: suites.map(suite => ({
          id: suite.id,
          name: suite.name,
          suiteType: suite.suiteType,
          parentSuiteId: suite.parentSuite?.id,
          isRoot: suite.id === plan.rootSuite?.id
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching test suites:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/test-plans - Create a new test plan
 */
app.post('/api/test-plans', async (req, res) => {
  try {
    const { project, name, areaPath, iteration } = req.body;
    const projectName = project || DEFAULT_PROJECT;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Test plan name is required'
      });
    }

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const testPlanApi = await connection.getTestPlanApi();

    // Use provided paths or fallback to project name
    const testPlanParams = {
      name: name,
      areaPath: areaPath || projectName,
      iteration: iteration || projectName
    };

    console.log('Creating test plan:', testPlanParams);

    const newPlan = await testPlanApi.createTestPlan(testPlanParams, projectName);

    res.json({
      success: true,
      data: {
        id: newPlan.id,
        name: newPlan.name,
        rootSuite: {
          id: newPlan.rootSuite.id,
          name: newPlan.rootSuite.name
        }
      }
    });
  } catch (error) {
    console.error('Error creating test plan:', error);

    // Better error messages
    let errorMessage = error.message;
    if (error.message.includes('area path')) {
      errorMessage = 'Invalid area path. Please select a valid area path from the dropdown.';
    } else if (error.message.includes('iteration')) {
      errorMessage = 'Invalid iteration path. Please select a valid iteration from the dropdown.';
    }

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /api/test-suites - Create a new test suite
 */
app.post('/api/test-suites', async (req, res) => {
  try {
    const { project, planId, name, suiteType, parentSuiteId, requirementId } = req.body;
    const projectName = project || DEFAULT_PROJECT;

    if (!planId || !name) {
      return res.status(400).json({
        success: false,
        error: 'planId and name are required'
      });
    }

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const testPlanApi = await connection.getTestPlanApi();

    // If no parent suite provided, get the root suite of the plan
    let actualParentSuiteId = parentSuiteId;
    if (!actualParentSuiteId) {
      const plan = await testPlanApi.getTestPlanById(projectName, parseInt(planId));
      if (!plan.rootSuite || !plan.rootSuite.id) {
        throw new Error('Could not determine root suite for test plan');
      }
      actualParentSuiteId = plan.rootSuite.id;
      console.log(`Using root suite ${actualParentSuiteId} as parent for new suite`);
    }

    const suiteParams = {
      name: name,
      suiteType: suiteType || 'StaticTestSuite',
      parentSuite: { id: actualParentSuiteId }
    };

    // For requirement-based suites
    if (suiteType === 'RequirementTestSuite') {
      if (!requirementId) {
        return res.status(400).json({
          success: false,
          error: 'requirementId is required for requirement-based test suites'
        });
      }
      suiteParams.requirementId = requirementId;
    }

    console.log('Creating test suite:', suiteParams);

    const newSuite = await testPlanApi.createTestSuite(
      suiteParams,
      projectName,
      parseInt(planId)
    );

    res.json({
      success: true,
      data: {
        id: newSuite.id,
        name: newSuite.name,
        suiteType: newSuite.suiteType,
        parentSuiteId: actualParentSuiteId
      }
    });
  } catch (error) {
    console.error('Error creating test suite:', error);

    let errorMessage = error.message;
    if (error.message.includes('requirement')) {
      errorMessage = 'Invalid requirement ID. Please ensure the work item exists and is a valid requirement type (PBI, User Story, or Requirement).';
    }

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /api/export-test-cases - Export generated test cases to DevOps
 */
app.post('/api/export-test-cases', async (req, res) => {
  try {
    const { project, planId, suiteId, testCasesMarkdown, pbiId } = req.body;
    const projectName = project || DEFAULT_PROJECT;

    if (!planId || !suiteId || !testCasesMarkdown) {
      return res.status(400).json({
        success: false,
        error: 'planId, suiteId, and testCasesMarkdown are required'
      });
    }

    const token = await getAzureToken();
    const authHandler = azdev.getBearerHandler(token);
    const connection = new azdev.WebApi(DEFAULT_ORG, authHandler);
    const witApi = await connection.getWorkItemTrackingApi();
    const testPlanApi = await connection.getTestPlanApi();

    // Parse test cases using flexible, format-agnostic parser
    console.log('Parsing test cases from markdown...');
    const testCases = parseTestCasesFromMarkdown(testCasesMarkdown);

    if (testCases.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No test cases found in markdown. Expected format: ## TC-001: Title'
      });
    }

    console.log(`Found ${testCases.length} test case(s) to export`);

    const createdTestCases = [];
    const errors = [];

    // Create each test case
    for (const testCase of testCases) {
      try {
        console.log(`Creating test case: ${testCase.title}`);

        // Create test case work item
        const document = [
          {
            op: 'add',
            path: '/fields/System.Title',
            value: testCase.title
          },
          {
            op: 'add',
            path: '/fields/Microsoft.VSTS.TCM.Steps',
            value: testCase.steps
          },
          {
            op: 'add',
            path: '/fields/System.Description',
            value: testCase.description || ''
          }
        ];

        // Link to PBI if provided
        if (pbiId) {
          document.push({
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
              url: `${DEFAULT_ORG}/${projectName}/_apis/wit/workItems/${pbiId}`,
              attributes: {
                comment: 'Tests'
              }
            }
          });
        }

        const workItem = await witApi.createWorkItem(
          null,
          document,
          projectName,
          'Test Case'
        );

        // Add test case to suite
        await testPlanApi.addTestCasesToSuite(
          projectName,
          parseInt(planId),
          parseInt(suiteId),
          [workItem.id]
        );

        createdTestCases.push({
          id: workItem.id,
          title: testCase.title
        });

        console.log(`✓ Created test case ${workItem.id}: ${testCase.title}`);
      } catch (testCaseError) {
        console.error(`✗ Failed to create test case ${testCase.title}:`, testCaseError.message);
        errors.push({
          title: testCase.title,
          error: testCaseError.message
        });
      }
    }

    // Return results even if some failed
    const response = {
      success: createdTestCases.length > 0,
      data: {
        testCasesCreated: createdTestCases.length,
        testCasesFailed: errors.length,
        testCases: createdTestCases
      }
    };

    if (errors.length > 0) {
      response.data.errors = errors;
      response.message = `Created ${createdTestCases.length} test case(s), ${errors.length} failed`;
    }

    res.json(response);
  } catch (error) {
    console.error('Error exporting test cases:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Knowledge Base Cache
let knowledgeCache = null;

// Examples Cache
let examplesCache = null;

function loadExamples() {
  if (examplesCache !== null) {
    return examplesCache; // Return cached (even if empty array)
  }

  const examples = [];
  const pbisPath = path.join(__dirname, 'knowledge/examples/pbis');
  const testCasesPath = path.join(__dirname, 'knowledge/examples/test-cases');

  try {
    // Check if directories exist
    if (!fs.existsSync(pbisPath) || !fs.existsSync(testCasesPath)) {
      console.log('ℹ Examples folders not found - skipping examples');
      examplesCache = [];
      return examplesCache;
    }

    // Read all files from both directories
    const pbiFiles = fs.readdirSync(pbisPath).filter(f => f.endsWith('.json') && f !== '.gitkeep');
    const testCaseFiles = fs.readdirSync(testCasesPath).filter(f => f.endsWith('.md') && f !== '.gitkeep');

    if (pbiFiles.length === 0 && testCaseFiles.length === 0) {
      console.log('ℹ No example files found in examples folders');
      examplesCache = [];
      return examplesCache;
    }

    console.log('');
    console.log('📝 Loading Examples...');
    console.log('--------------------------------------------');

    // Match PBI files with their corresponding test case files
    pbiFiles.forEach(pbiFile => {
      const baseName = path.basename(pbiFile, '.json');
      const testCaseFile = `${baseName}.md`;

      if (testCaseFiles.includes(testCaseFile)) {
        try {
          const pbiContent = fs.readFileSync(path.join(pbisPath, pbiFile), 'utf-8');
          const testCaseContent = fs.readFileSync(path.join(testCasesPath, testCaseFile), 'utf-8');

          examples.push({
            name: baseName,
            pbi: pbiContent,
            testCases: testCaseContent
          });

          console.log(`✓ Loaded example pair: ${baseName}`);
          console.log(`  → PBI: ${pbiFile} (${(pbiContent.length / 1024).toFixed(1)} KB)`);
          console.log(`  → Test Cases: ${testCaseFile} (${(testCaseContent.length / 1024).toFixed(1)} KB)`);
        } catch (error) {
          console.log(`✗ Error loading example pair ${baseName}:`, error.message);
        }
      } else {
        console.log(`⚠ PBI file ${pbiFile} has no matching test case file (expected: ${testCaseFile})`);
      }
    });

    // Warn about orphaned test case files
    testCaseFiles.forEach(testCaseFile => {
      const baseName = path.basename(testCaseFile, '.md');
      const pbiFile = `${baseName}.json`;
      if (!pbiFiles.includes(pbiFile)) {
        console.log(`⚠ Test case file ${testCaseFile} has no matching PBI file (expected: ${pbiFile})`);
      }
    });

    console.log('--------------------------------------------');
    if (examples.length > 0) {
      console.log(`✓ Loaded ${examples.length} example pair(s)`);
    } else {
      console.log('ℹ No matching example pairs found');
    }
    console.log('');

    examplesCache = examples;
    return examplesCache;
  } catch (error) {
    console.error('✗ Error loading examples:', error.message);
    console.log('');
    examplesCache = [];
    return examplesCache;
  }
}

// Standalone Test Case Examples Cache
let standaloneExamplesCache = null;

function loadStandaloneTestCaseExamples() {
  if (standaloneExamplesCache !== null) {
    return standaloneExamplesCache;
  }

  const standaloneExamples = {
    good: null,
    bad: null
  };

  const testCasesPath = path.join(__dirname, 'knowledge/examples/test-cases');

  try {
    const goodPath = path.join(testCasesPath, 'good-test-cases.md');
    const badPath = path.join(testCasesPath, 'bad-test-cases.md');

    if (fs.existsSync(goodPath)) {
      standaloneExamples.good = fs.readFileSync(goodPath, 'utf-8');
      console.log(`✓ Loaded good test case examples (${(standaloneExamples.good.length / 1024).toFixed(1)} KB)`);
    }

    if (fs.existsSync(badPath)) {
      standaloneExamples.bad = fs.readFileSync(badPath, 'utf-8');
      console.log(`✓ Loaded bad test case examples (${(standaloneExamples.bad.length / 1024).toFixed(1)} KB)`);
    }

    if (!standaloneExamples.good && !standaloneExamples.bad) {
      console.log('ℹ No standalone test case examples found');
    }

    standaloneExamplesCache = standaloneExamples;
    return standaloneExamplesCache;
  } catch (error) {
    console.error('✗ Error loading standalone test case examples:', error.message);
    standaloneExamplesCache = { good: null, bad: null };
    return standaloneExamplesCache;
  }
}

// Definition of Done Cache
let definitionOfDoneCache = null;

function loadDefinitionOfDone() {
  if (definitionOfDoneCache !== null) {
    return definitionOfDoneCache; // Return cached (even if empty array)
  }

  const definitions = [];
  const dodPath = path.join(__dirname, 'knowledge/examples/definition-of-done');

  try {
    // Check if directory exists
    if (!fs.existsSync(dodPath)) {
      console.log('ℹ Definition of Done folder not found - skipping quality criteria');
      definitionOfDoneCache = [];
      return definitionOfDoneCache;
    }

    // Read all markdown files
    const dodFiles = fs.readdirSync(dodPath).filter(f => f.endsWith('.md') && !f.includes('README'));

    if (dodFiles.length === 0) {
      console.log('ℹ No Definition of Done files found - skipping quality criteria');
      definitionOfDoneCache = [];
      return definitionOfDoneCache;
    }

    console.log('');
    console.log('📋 Loading Definition of Done...');
    console.log('--------------------------------------------');

    dodFiles.forEach(file => {
      try {
        const content = fs.readFileSync(path.join(dodPath, file), 'utf-8');
        definitions.push({
          name: file,
          content: content
        });
        console.log(`✓ Loaded: ${file}`);
        console.log(`  → ${(content.length / 1024).toFixed(1)} KB - Quality criteria for self-review`);
      } catch (error) {
        console.log(`✗ Error loading ${file}:`, error.message);
      }
    });

    console.log('--------------------------------------------');
    if (definitions.length > 0) {
      console.log(`✓ Loaded ${definitions.length} Definition of Done file(s)`);
      console.log('  → Claude will use these for self-review and quality scoring');
    } else {
      console.log('ℹ No Definition of Done files loaded');
    }
    console.log('');

    definitionOfDoneCache = definitions;
    return definitionOfDoneCache;
  } catch (error) {
    console.error('✗ Error loading Definition of Done:', error.message);
    console.log('');
    definitionOfDoneCache = [];
    return definitionOfDoneCache;
  }
}

function loadKnowledgeBase() {
  if (knowledgeCache) {
    console.log('📚 Using cached knowledge base');
    return knowledgeCache;
  }

  console.log('');
  console.log('📚 Loading Knowledge Base...');
  console.log('--------------------------------------------');

  try {
    const testingStandards = fs.readFileSync(path.join(__dirname, 'knowledge/testing-standards.md'), 'utf-8');
    console.log('✓ Loaded: testing-standards.md');
    console.log(`  → ${(testingStandards.length / 1024).toFixed(1)} KB - GL Assessment testing standards (DoR/DoD, test types)`);

    const glossary = fs.readFileSync(path.join(__dirname, 'knowledge/glossary.md'), 'utf-8');
    console.log('✓ Loaded: glossary.md');
    console.log(`  → ${(glossary.length / 1024).toFixed(1)} KB - Domain terminology (CAT4, NGRT, SAS, etc.)`);

    const platformOverview = fs.readFileSync(path.join(__dirname, 'knowledge/platform-overview.md'), 'utf-8');
    console.log('✓ Loaded: platform-overview.md');
    console.log(`  → ${(platformOverview.length / 1024).toFixed(1)} KB - Platform architecture & tech stack`);

    knowledgeCache = {
      testingStandards,
      glossary,
      platformOverview
    };

    const totalSize = (testingStandards.length + glossary.length + platformOverview.length) / 1024;
    console.log('--------------------------------------------');
    console.log(`✓ Knowledge base loaded successfully (${totalSize.toFixed(1)} KB total)`);
    console.log('');

    return knowledgeCache;
  } catch (error) {
    console.error('✗ Error loading knowledge base:', error);
    console.log('');
    return null;
  }
}

// Build request-scoped context to avoid duplicate loading
function buildRequestContext() {
  return {
    knowledge: loadKnowledgeBase(),
    examples: loadExamples(),
    standaloneExamples: loadStandaloneTestCaseExamples(),
    definitionOfDone: loadDefinitionOfDone(),
    knowledgeContext: null // Built once, reused
  };
}

// Prompt builders
function buildTestCasesPrompt(data, additionalContext, requestContext = null, generateAll = false) {
  console.log('');
  console.log('🧠 Building test case generation prompt...');
  console.log('--------------------------------------------');

  // Use provided context or load fresh (fallback for standalone use)
  const knowledge = requestContext?.knowledge || loadKnowledgeBase();
  const examples = requestContext?.examples || loadExamples();
  const standaloneExamples = requestContext?.standaloneExamples || loadStandaloneTestCaseExamples();

  let knowledgeContext = '';
  if (knowledge) {
    console.log('📖 Applying knowledge base context:');
    console.log('  ✓ Testing standards (DoR/DoD, acceptance criteria format)');
    console.log('  ✓ Domain glossary (product names, technical terms)');
    console.log('  ✓ Platform overview (architecture, tech stack, products)');
    console.log('');
    console.log('🎯 Test Generation Strategy:');
    console.log('  → Test Case #1: Happy Path (mandatory first test)');
    console.log('  → Followed by: Edge cases, negative tests, accessibility, etc.');

    if (examples.length > 0) {
      console.log('');
      console.log('📋 Using Example PBI/Test Case Pairs:');
      examples.forEach((example, index) => {
        console.log(`  ${index + 1}. ${example.name}`);
      });
      console.log('  → Claude will learn from these examples');
    } else {
      console.log('');
      console.log('ℹ No PBI/test case pairs found');
    }

    if (standaloneExamples.good || standaloneExamples.bad) {
      console.log('');
      console.log('✅ Using Standalone Test Case Examples:');
      if (standaloneExamples.good) {
        console.log('  ✓ Good test case examples (what TO do)');
      }
      if (standaloneExamples.bad) {
        console.log('  ✓ Bad test case examples (what NOT to do)');
      }
      console.log('  → Claude will learn quality standards from these');
    }

    console.log('--------------------------------------------');
    console.log('✓ Prompt ready with full GL Assessment context');
    console.log('');

    knowledgeContext = `
# CONTEXT: GL Assessment Testing Standards and Platform Knowledge

You are generating test cases for GL Assessment's Testwise platform. Use the following knowledge to inform your test case generation:

${knowledge.testingStandards}

---

${knowledge.glossary}

---

${knowledge.platformOverview}

---

${examples.length > 0 ? `
# EXAMPLES: Learn from High-Quality Test Cases

Below are examples of well-written PBIs and their corresponding test cases. Use these as references for format, structure, quality, and level of detail when generating test cases.

${examples.map((example, index) => `
## Example ${index + 1}: ${example.name}

### Example PBI:
${example.pbi}

### Example Test Cases:
${example.testCases}

---
`).join('\n')}

` : ''}
${standaloneExamples.good || standaloneExamples.bad ? `
# QUALITY EXAMPLES: Learn What Makes Good vs. Bad Test Cases

${standaloneExamples.bad ? `
## ❌ BAD TEST CASES (What NOT to Do)

The following examples demonstrate POOR test case quality. These are real examples of badly-written test cases that you should AVOID:

${standaloneExamples.bad}

**Problems with the above examples:**
- Vague or unclear language (e.g., "Evoke validation")
- Missing Given/When/Then structure
- Inconsistent test case numbering
- Missing preconditions and test scenarios
- Undefined terms or references without context
- No clear description of what's being tested

` : ''}
${standaloneExamples.good ? `
## ✅ GOOD TEST CASES (What TO Do)

The following examples demonstrate HIGH-QUALITY test cases. Use these as your standard:

${standaloneExamples.good}

**Why these examples are excellent:**
- Clear Given/When/Then format throughout
- Specific preconditions stated upfront
- Detailed test scenario descriptions
- Precise language (URLs, dates, validation messages)
- Logical step-by-step flow
- Helpful notes where needed
- Each step has clear expected results

` : ''}
**YOUR GOAL**: Generate test cases that match the GOOD examples and avoid the mistakes shown in the BAD examples.

` : ''}
# YOUR TASK

Now, using the standards, context${examples.length > 0 || standaloneExamples.good || standaloneExamples.bad ? ', and examples' : ''} above, analyze the following Product Backlog Item (PBI) and generate comprehensive test cases in the same high-quality format as the good examples.
`;
  } else {
    console.log('⚠ Warning: Knowledge base not loaded - generating without GL context');
    console.log('--------------------------------------------');
    console.log('');
  }

  return `${knowledgeContext}

## PBI Details

${JSON.stringify(data, null, 2)}
${additionalContext ? `

## Additional Context from Quality Assessment

The following information was provided to clarify missing or unclear aspects of the PBI:

${additionalContext}

**IMPORTANT**: Use this additional context to generate more accurate and comprehensive test cases. This information addresses gaps identified during quality assessment.

---
` : ''}

# CRITICAL INSTRUCTION: Response Structure

Your response must follow this exact structure:

**1. Test Suite Summary Section (FIRST - appears before TC-001):**
If there are critical gaps, assumptions, dependencies, or scope clarifications that testers need to know, include a brief summary section BEFORE TC-001:

\`\`\`markdown
## Test Suite Summary

### Critical Gaps Identified
[List any critical gaps in the PBI that affect testing - keep brief, 2-4 bullet points max]

### Assumptions Made
[List key assumptions made for test generation - keep brief, 2-4 bullet points max]

### Test Case Dependencies
[List any prerequisites or dependencies needed before testing can begin - e.g., "Requires DEVCI environment access", "Database must be seeded with test data", "API endpoints must be deployed"]

### Out of Scope
[Clearly state what is NOT covered by these test cases - e.g., "Performance testing", "Security penetration testing", "Load testing under 1000+ concurrent users"]

### Risk Assessment
[Brief risk summary if applicable - 1-2 sentences highlighting the highest risk areas]
\`\`\`

**2. Test Cases Section (MAIN CONTENT):**
Immediately after the summary (or if no summary needed, start your response here), begin with TC-001 and continue with all test cases.

**IMPORTANT:**
- Keep the summary section EXTREMELY CONCISE - use bullet points, not paragraphs
- Target: 150-200 words MAXIMUM for the entire summary section
- Each subsection should have 2-4 bullet points max - be brief and direct
- Only include sections that are truly relevant - omit sections if they don't apply
- If the PBI is clear and complete with no significant gaps or dependencies, skip the summary section entirely and start directly with TC-001
- Do NOT include lengthy explanations, PBI critiques, or extensive action items
- Focus on what testers MUST know, not nice-to-know information

---

## Requirements

${generateAll ? `Generate a comprehensive **MANUAL TEST PLAN** that includes:

**REMINDER: Begin your response directly with test cases. Do NOT include PBI quality assessment, gaps analysis, or assumptions sections.**

**IMPORTANT: The very first test case (Test Case #1) MUST be the Happy Path scenario - the ideal, successful user journey with valid inputs and expected successful outcomes.**

1. **Happy Path Test (TEST CASE #1 - MANDATORY)**
   - This MUST be the first test case in your test plan
   - Cover the primary, successful user journey
   - Use valid data and expected inputs
   - Verify all steps complete successfully
   - Format in Given/When/Then structure
   - Include clear step-by-step instructions
   - Specify expected successful results

2. **Additional Acceptance Criteria Tests** (Given/When/Then format)
   - Cover all remaining acceptance criteria from the PBI
   - Include variations and alternative paths
   - Provide clear step-by-step instructions
   - Specify expected results for each test

3. **Functional Test Scenarios**
   - Core functionality tests
   - User workflows and journeys
   - UI interactions and navigation
   - Data input and validation
   - Form submissions
   - Search and filtering functionality

4. **Edge Cases and Boundary Tests**
   - Boundary values (minimum/maximum)
   - Empty/null data scenarios
   - Special characters and unusual inputs
   - Large data sets
   - Concurrent user scenarios (if applicable)

5. **Negative Test Cases**
   - Invalid inputs
   - Incorrect data formats
   - Unauthorized access attempts
   - Error message validation
   - System behavior under failure conditions

6. **User Acceptance Testing (UAT) Scenarios**
   - Real-world user scenarios
   - Business process validation
   - End-to-end user journeys

7. **Cross-Browser Testing**
   - Chrome (primary browser)
   - Edge, Firefox, Safari (sanity checks)
   - Responsive design on different screen sizes
   - Mobile device testing (if applicable)

8. **Accessibility Testing** (Manual checks)
   - Keyboard navigation (Tab, Enter, Escape)
   - Screen reader compatibility testing
   - Color contrast verification
   - Focus indicators visibility
   - Alt text for images

9. **Performance and Usability**
   - Page load time observations
   - Response time for actions
   - UI responsiveness
   - Error handling and user feedback

10. **Security Testing** (Manual verification)
    - Authentication and authorization checks
    - Data validation
    - Session management
    - Sensitive data handling

11. **Exploratory Testing Suggestions**
    - Areas to explore freely
    - Potential risk areas
    - Integration points to verify` :
`
### FOCUSED TEST GENERATION MODE - Generate ONLY 6 Test Cases

**REMINDER: Begin your response directly with TC-001. Do NOT include PBI quality assessment, gaps analysis, or assumptions sections.**

**YOU ARE GENERATING A FOCUSED TEST PLAN WITH EXACTLY 6 TEST CASES. NO MORE, NO LESS.**

**List of test cases you will generate:**
1. TC-001 (Happy Path)
2. TC-002 (Critical Test #1)
3. TC-003 (Critical Test #2)
4. TC-004 (Critical Test #3)
5. TC-005 (Critical Test #4)
6. TC-006 (Critical Test #5)

**AFTER TC-006, YOUR RESPONSE MUST END. DO NOT CONTINUE.**

---

**TC-001: Happy Path Test (MANDATORY FIRST TEST)**
- This MUST be the first test case
- Cover the primary, successful user journey with valid inputs
- Format in Given/When/Then structure
- Include: Test Scenario, Priority, Preconditions, Test Steps, Test Data, Expected Result, Notes

**TC-002 through TC-006: The 5 Most Critical Tests**
- Identify the 5 MOST CRITICAL tests needed to validate this PBI
- Prioritize based on:
  * Risk to business operations
  * Impact if functionality fails
  * Coverage of key acceptance criteria
  * Security/data integrity concerns
- For EACH of these 5 tests, provide full detail: Test Scenario, Priority, Preconditions, Test Steps, Test Data, Expected Result, Notes

---

**CRITICAL CONSTRAINTS:**

❌ **DO NOT generate TC-007**
❌ **DO NOT generate TC-008**
❌ **DO NOT generate TC-009**
❌ **DO NOT generate TC-010**
❌ **DO NOT generate TC-011**
❌ **DO NOT generate TC-012 or higher**
❌ **DO NOT add a "Part 2" or "Additional Tests" section**
❌ **DO NOT add summary test suggestions**
❌ **DO NOT list additional recommended tests**

✅ **END YOUR RESPONSE IMMEDIATELY AFTER TC-006**

The user will request additional tests separately if needed. Your task is to generate ONLY the 6 most important tests.
`}

## Test Case Format

${generateAll ? `
For ALL test cases, provide:
- **Test Case ID**: Unique identifier (TC-001, TC-002, etc.)
- **Test Scenario**: Brief description
- **Priority**: Critical/High/Medium/Low
- **Preconditions**: What must be set up or true before testing
- **Test Steps**: Numbered, clear, step-by-step instructions in Given/When/Then format
- **Test Data**: Specific data values to use
- **Expected Result**: What should happen
- **Notes**: Any additional context or considerations

**REMINDER**:
- Test Case #1 (TC-001) MUST be the Happy Path - the successful, ideal scenario with valid inputs.
- Do NOT include PBI quality commentary or assessment - just generate test cases.
- Begin your response directly with the test cases.
` : `
For EACH of the 6 test cases (TC-001, TC-002, TC-003, TC-004, TC-005, TC-006), provide:
- **Test Case ID**: TC-001, TC-002, TC-003, TC-004, TC-005, or TC-006 ONLY
- **Test Scenario**: Brief description
- **Priority**: Critical/High/Medium/Low
- **Preconditions**: What must be set up or true before testing
- **Test Steps**: Numbered, clear, step-by-step instructions in Given/When/Then format
- **Test Data**: Specific data values to use
- **Expected Result**: What should happen
- **Notes**: Any additional context or considerations

**FINAL REMINDER:**
- TC-001 MUST be the Happy Path
- Generate exactly 6 tests total
- After completing TC-006, END your response immediately
- Do NOT number tests beyond TC-006
- Do NOT include PBI quality commentary - just generate test cases
`}

Format the response as a structured, detailed manual test plan organized by category. Use markdown formatting with clear headings, numbered steps, and bullet points. Make it easy for a manual tester to execute.

**Begin your response directly with the test cases. Do not include introductory text, PBI critiques, or quality assessments.**`;
}

function buildImpactAnalysisPrompt(data) {
  return `Analyze the impact of the following Product Backlog Item (PBI):

${JSON.stringify(data, null, 2)}

Please identify:
1. Which system components are affected
2. Potential breaking changes
3. Dependencies that might be impacted
4. Database schema changes
5. API contract changes
6. Risk assessment (low/medium/high)

Provide a structured impact analysis.`;
}

function buildDocumentationPrompt(data) {
  return `Generate documentation for the following Product Backlog Item (PBI):

${JSON.stringify(data, null, 2)}

Please create:
1. User-facing documentation (if applicable)
2. Technical documentation for developers
3. Release notes entry
4. API documentation changes (if applicable)

Use clear, professional language suitable for different audiences.`;
}

// Self-Review and Quality Functions
function buildSelfReviewPrompt(testCases, definitionOfDone, knowledgeContext, examples, requestContext = null) {
  const standaloneExamples = requestContext?.standaloneExamples || loadStandaloneTestCaseExamples();

  const dodContext = definitionOfDone.length > 0 ? `
# Definition of Done Criteria

Review the test cases against these quality standards:

${definitionOfDone.map(dod => `
## ${dod.name}
${dod.content}
`).join('\n')}
` : '';

  const examplesContext = examples.length > 0 ? `
# Example Test Cases for Reference

Review the test cases against these high-quality examples:

${examples.map((example, index) => `
## Example ${index + 1}: ${example.name}

### Example Test Cases:
${example.testCases}

---
`).join('\n')}
` : '';

  const qualityExamplesContext = standaloneExamples.good || standaloneExamples.bad ? `
# Quality Standards: Good vs. Bad Test Cases

${standaloneExamples.bad ? `
## ❌ BAD TEST CASES (Red Flags to Look For)

${standaloneExamples.bad}

` : ''}
${standaloneExamples.good ? `
## ✅ GOOD TEST CASES (Quality Standard)

${standaloneExamples.good}

` : ''}
Compare the test cases under review against these quality standards.
` : '';

  return `${knowledgeContext}

${dodContext}

${examplesContext}

${qualityExamplesContext}

# Test Cases to Review

${testCases}

---

# Your Task

Review the test cases above and evaluate them against:
${definitionOfDone.length > 0 ? '- The Definition of Done criteria' : '- General quality standards'}
- The GL Assessment testing standards provided
${examples.length > 0 ? '- The example test cases for comparison' : ''}
${standaloneExamples.good || standaloneExamples.bad ? '- The good/bad quality examples (ensure they match good examples, avoid bad example mistakes)' : ''}

Provide a structured review in this format:

## Overall Assessment
[Brief summary of quality level]

## Strengths
- [What's good about these test cases]

## Issues Found
1. **[Issue Category]**: [Specific problem and location]
2. **[Issue Category]**: [Specific problem and location]
[Continue for all issues]

## Recommended Improvements
1. [Specific actionable improvement]
2. [Specific actionable improvement]
[Continue for all recommendations]

## Ready for Use?
[YES or NO] - If NO, explain what critical issues must be addressed.

Be specific about test case IDs and exact issues. Focus on actionable feedback.`;
}

function buildImprovedTestCasesPrompt(originalTestCases, reviewFeedback, pbiData, knowledgeContext, definitionOfDone, generateAll = false) {
  return `${knowledgeContext}

## PBI Details

${JSON.stringify(pbiData, null, 2)}

## Previous Test Cases

${originalTestCases}

## Review Feedback

${reviewFeedback}

---

# Your Task

Generate IMPROVED test cases that address all the issues identified in the review feedback.

**DO NOT include PBI quality assessment, gaps analysis, or assumptions sections. Generate test cases only.**

${definitionOfDone.length > 0 ? `Ensure the improved test cases fully comply with the Definition of Done criteria provided earlier.` : ''}

${!generateAll ? `
**CRITICAL: You are in FOCUSED MODE - Generate ONLY 6 Test Cases**

You MUST maintain exactly 6 test cases:
1. TC-001 (Happy Path)
2. TC-002 (Critical Test #1)
3. TC-003 (Critical Test #2)
4. TC-004 (Critical Test #3)
5. TC-005 (Critical Test #4)
6. TC-006 (Critical Test #5)

**CONSTRAINTS:**
❌ DO NOT generate TC-007 or higher
❌ DO NOT add additional test suggestions
❌ END YOUR RESPONSE IMMEDIATELY AFTER TC-006

Fix the identified issues in the existing 6 test cases, but maintain exactly 6 tests total.

` : `Maintain the same structure and categories, but fix all identified issues.`}

**REMINDER: Test Case #1 (TC-001) MUST be the Happy Path.**

Generate the complete improved test plan now.`;
}

function buildQualityScoringPrompt(testCases, definitionOfDone) {
  const dodContext = definitionOfDone.length > 0 ? `using the Definition of Done criteria provided earlier` : `using general quality standards for manual test cases`;

  return `# Test Cases to Score

${testCases}

---

# Your Task

Evaluate the quality of these test cases ${dodContext}.

Provide your assessment in this EXACT format:

## Quality Score: [X]/10

## Justification
[2-3 sentences explaining the score]

## Strengths
- [Key strength 1]
- [Key strength 2]
- [Key strength 3]

## Areas for Improvement (if any)
- [Improvement area 1]
- [Improvement area 2]

Keep your response concise and focused.`;
}

async function improveTestCasesWithFeedback(pbiData, previousTestCases, userFeedback, additionalContext, progressCallback = null, requestContext = null, generateAll = false) {
  const knowledge = requestContext?.knowledge || loadKnowledgeBase();
  const standaloneExamples = requestContext?.standaloneExamples || loadStandaloneTestCaseExamples();
  const definitionOfDone = requestContext?.definitionOfDone || loadDefinitionOfDone();

  console.log('');
  console.log('--------------------------------------------');
  if (progressCallback) progressCallback('Applying feedback');

  // Build knowledge context
  let knowledgeContext = '';
  if (knowledge) {
    knowledgeContext = `
# CONTEXT: GL Assessment Testing Standards and Platform Knowledge

${knowledge.testingStandards}

---

${knowledge.glossary}

---

${knowledge.platformOverview}

---

${standaloneExamples.good || standaloneExamples.bad ? `
# QUALITY STANDARDS

${standaloneExamples.bad ? `
## ❌ Avoid These Mistakes

${standaloneExamples.bad}

` : ''}
${standaloneExamples.good ? `
## ✅ Follow This Quality Standard

${standaloneExamples.good}

` : ''}
` : ''}
`;
  }

  // Build improvement prompt
  const improvementPrompt = `${knowledgeContext}

## PBI Details

${JSON.stringify(pbiData, null, 2)}
${additionalContext ? `

## Additional Context from Quality Assessment

The following information was provided to clarify missing or unclear aspects of the PBI:

${additionalContext}

---
` : ''}

---

## Previous Test Cases

${previousTestCases}

---

## User Feedback

The user has reviewed the test cases above and provided the following feedback:

"${userFeedback}"

---

# Your Task

Generate IMPROVED test cases that address the user's feedback while maintaining all the good aspects of the previous version.

**DO NOT include PBI quality assessment, gaps analysis, or assumptions sections. Generate test cases only.**

**Instructions:**
- Keep the same structure and format
- Address the specific feedback provided
- Maintain quality and completeness
- **IMPORTANT: Test Case #1 (TC-001) MUST remain the Happy Path**
- Only make changes related to the user's feedback
- If the user asks for specific changes (e.g., "only give me one test"), follow that instruction exactly

${!generateAll ? `
**CRITICAL: You are in FOCUSED MODE - Maintain ONLY 6 Test Cases**

You MUST keep exactly 6 test cases:
1. TC-001 (Happy Path)
2. TC-002 (Critical Test #1)
3. TC-003 (Critical Test #2)
4. TC-004 (Critical Test #3)
5. TC-005 (Critical Test #4)
6. TC-006 (Critical Test #5)

**CONSTRAINTS:**
❌ DO NOT add TC-007 or higher
❌ DO NOT add additional test suggestions
❌ END YOUR RESPONSE IMMEDIATELY AFTER TC-006

` : ''}

Generate the complete improved test plan now.`;

  console.log('🤖 Calling Claude to improve test cases with user feedback...');
  if (progressCallback) progressCallback('Regenerating with feedback');
  const improvedTestCases = await invokeClaudeOnBedrock(improvementPrompt);
  console.log('✓ Improved test cases generated');

  // Generate quality score if DoD exists
  let qualityScore = null;
  if (definitionOfDone.length > 0) {
    console.log('📊 Generating quality score...');
    if (progressCallback) progressCallback('Generating quality score');
    const scoringPrompt = buildQualityScoringPrompt(improvedTestCases, definitionOfDone);
    qualityScore = await invokeClaudeOnBedrock(scoringPrompt);
    console.log('✓ Quality score generated');
  }

  if (progressCallback) progressCallback('Complete');
  console.log('============================================');
  console.log('');

  return {
    testCases: improvedTestCases,
    qualityScore: qualityScore
  };
}

async function generateTestCasesWithQuality(pbiData, additionalContext, progressCallback = null, requestContext = null, generateAll = false) {
  const MAX_ITERATIONS = 3;
  const knowledge = requestContext?.knowledge || loadKnowledgeBase();
  const examples = requestContext?.examples || loadExamples();
  const standaloneExamples = requestContext?.standaloneExamples || loadStandaloneTestCaseExamples();
  const definitionOfDone = requestContext?.definitionOfDone || loadDefinitionOfDone();

  console.log('');
  console.log('🔄 Starting Iterative Test Generation with Quality Review...');
  console.log('--------------------------------------------');
  if (progressCallback) progressCallback('Starting tests generation');

  // Build knowledge context once
  let knowledgeContext = '';
  if (knowledge) {
    knowledgeContext = `
# CONTEXT: GL Assessment Testing Standards and Platform Knowledge

You are generating test cases for GL Assessment's Testwise platform. Use the following knowledge to inform your test case generation:

${knowledge.testingStandards}

---

${knowledge.glossary}

---

${knowledge.platformOverview}

---

${examples.length > 0 ? `
# EXAMPLES: Learn from High-Quality Test Cases

Below are examples of well-written PBIs and their corresponding test cases. Use these as references for format, structure, quality, and level of detail when generating test cases.

${examples.map((example, index) => `
## Example ${index + 1}: ${example.name}

### Example PBI:
${example.pbi}

### Example Test Cases:
${example.testCases}

---
`).join('\n')}

` : ''}
${standaloneExamples.good || standaloneExamples.bad ? `
# QUALITY EXAMPLES: Learn What Makes Good vs. Bad Test Cases

${standaloneExamples.bad ? `
## ❌ BAD TEST CASES (What NOT to Do)

${standaloneExamples.bad}

` : ''}
${standaloneExamples.good ? `
## ✅ GOOD TEST CASES (What TO Do)

${standaloneExamples.good}

` : ''}
` : ''}`;
  }

  let currentTestCases = '';
  let iteration = 0;
  let isReadyForUse = false;
  let lastReview = '';

  // Iteration loop
  while (iteration < MAX_ITERATIONS && !isReadyForUse) {
    iteration++;
    console.log(`\n📝 Iteration ${iteration}/${MAX_ITERATIONS}`);

    if (iteration === 1) {
      // First generation
      console.log('  → Generating initial test cases...');
      if (progressCallback) progressCallback('Initial tests generating');
      const initialPrompt = buildTestCasesPrompt(pbiData, additionalContext, requestContext, generateAll);
      currentTestCases = await invokeClaudeOnBedrock(initialPrompt);
      console.log('  ✓ Initial test cases generated');
    } else {
      // Improvement iteration
      console.log('  → Generating improved test cases based on review...');
      if (progressCallback) progressCallback(`Iteration ${iteration - 1}`);
      const improvementPrompt = buildImprovedTestCasesPrompt(
        currentTestCases,
        lastReview,
        pbiData,
        knowledgeContext,
        definitionOfDone,
        generateAll
      );
      currentTestCases = await invokeClaudeOnBedrock(improvementPrompt);
      console.log('  ✓ Improved test cases generated');
    }

    // Always do self-review unless we're on the last iteration
    if (iteration < MAX_ITERATIONS) {
      if (definitionOfDone.length > 0) {
        console.log('  → Performing self-review against Definition of Done, knowledge base, and examples...');
      } else {
        console.log('  → Performing self-review against knowledge base, examples, and general quality standards...');
      }
      if (progressCallback) progressCallback('Reviewing test cases');

      const reviewPrompt = buildSelfReviewPrompt(currentTestCases, definitionOfDone, knowledgeContext, examples, requestContext);
      lastReview = await invokeClaudeOnBedrock(reviewPrompt);
      console.log('  ✓ Self-review complete');

      // Check if ready
      isReadyForUse = lastReview.toLowerCase().includes('ready for use?\nyes') ||
                      lastReview.toLowerCase().includes('ready for use? yes');

      if (isReadyForUse) {
        console.log('  ✅ Test cases meet quality standards!');
        if (progressCallback) progressCallback('Test cases approved');
      } else {
        console.log('  ⚠ Issues found - will iterate');
      }
    } else {
      // Last iteration - accept the output
      isReadyForUse = true;
      console.log('  ℹ Maximum iterations reached - accepting current version');
      if (progressCallback) progressCallback('Final iteration');
    }
  }

  console.log(`\n✓ Test generation complete after ${iteration} iteration(s)`);

  // Generate quality score
  console.log('📊 Generating quality score...');
  if (progressCallback) progressCallback('Generating quality score');
  const scoringPrompt = buildQualityScoringPrompt(currentTestCases, definitionOfDone);
  const qualityScore = await invokeClaudeOnBedrock(scoringPrompt);
  console.log('✓ Quality score generated');
  if (progressCallback) progressCallback('Complete');

  console.log('============================================');
  console.log('');

  return {
    testCases: currentTestCases,
    qualityScore: qualityScore,
    iterations: iteration
  };
}

// Serve Angular app
app.use(express.static(path.join(__dirname, 'dist/pbi-pr-analyzer/browser')));

// Fallback to index.html for Angular routing (Express 5 compatible)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist/pbi-pr-analyzer/browser/index.html'));
});

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('');
  console.error('============================================');
  console.error('  UNCAUGHT EXCEPTION');
  console.error('============================================');
  console.error('');
  console.error(error);
  console.error('');
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('');
  console.error('============================================');
  console.error('  UNHANDLED PROMISE REJECTION');
  console.error('============================================');
  console.error('');
  console.error(error);
  console.error('');
  process.exit(1);
});

// Start server
const server = app.listen(PORT, () => {
  console.log('');
  console.log('============================================');
  console.log('  PBI Manual Test Case Generator Server');
  console.log('============================================');
  console.log('');
  console.log(`  Server running at: http://localhost:${PORT}`);
  console.log('');

  // Check knowledge base availability
  const knowledgeFiles = [
    'knowledge/testing-standards.md',
    'knowledge/glossary.md',
    'knowledge/platform-overview.md'
  ];

  let allFilesExist = true;
  knowledgeFiles.forEach(file => {
    if (!fs.existsSync(path.join(__dirname, file))) {
      allFilesExist = false;
    }
  });

  if (allFilesExist) {
    console.log('  📚 Knowledge Base: Ready');
    console.log('     • Testing Standards');
    console.log('     • Domain Glossary');
    console.log('     • Platform Overview');
  } else {
    console.log('  ⚠  Knowledge Base: Missing files!');
  }
  console.log('');
  console.log('  Opening browser...');
  console.log('============================================');
  console.log('');

  // Open browser automatically
  const openCommand = process.platform === 'win32' ? 'start' :
                     process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    execSync(`${openCommand} http://localhost:${PORT}`, { stdio: 'ignore' });
  } catch (error) {
    console.log('  Please open: http://localhost:3000');
  }
});

// Handle server errors
server.on('error', (error) => {
  console.error('');
  console.error('============================================');
  console.error('  SERVER ERROR');
  console.error('============================================');
  console.error('');
  if (error.code === 'EADDRINUSE') {
    console.error(`  Port ${PORT} is already in use!`);
    console.error('');
    console.error('  Either:');
    console.error('  1. Stop the other application using port 3000');
    console.error('  2. Change the PORT in server.js');
  } else {
    console.error(error);
  }
  console.error('');
  process.exit(1);
});
