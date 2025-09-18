import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

import type { KafkaConfig, SASLOptions } from 'kafkajs';
import { Kafka as ApacheKafka, logLevel } from 'kafkajs';

export class KafkaWaitEvent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Kafka Wait Event',
		name: 'kafkaWaitEvent',
		icon: { light: 'file:kafka.svg', dark: 'file:kafka.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["topicName"]}} ({{$parameter["timeoutSeconds"]}}s)',
		description: 'Wait for specific Kafka events with timeout',
		defaults: {
			name: 'Kafka Wait Event',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'kafka',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Topic Name',
				name: 'topicName',
				type: 'string',
				default: '',
				placeholder: 'my-topic',
				description: 'Name of the Kafka topic to listen to',
				required: true,
			},
			{
				displayName: 'Group ID',
				name: 'groupId',
				type: 'string',
				default: 'n8n-kafka-wait-event',
				description: 'Consumer group ID for this instance',
				required: true,
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 30,
				description: 'Maximum time to wait for a message (in seconds)',
				required: true,
			},
			{
				displayName: 'Read From Beginning',
				name: 'readFromBeginning',
				type: 'boolean',
				default: false,
				description: 'Whether to read from the beginning of the topic',
			},
			{
				displayName: 'Filter Options',
				name: 'filterOptions',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				options: [
					{
						displayName: 'Message Key Filter',
						name: 'keyFilter',
						type: 'string',
						default: '',
						description: 'Filter messages by key (exact match)',
					},
					{
						displayName: 'Message Value Filter (JSON Path)',
						name: 'valueFilter',
						type: 'string',
						default: '',
						placeholder: '$.eventType',
						description: 'JSONPath expression to filter message content',
					},
					{
						displayName: 'Expected Value',
						name: 'expectedValue',
						type: 'string',
						default: '',
						description: 'Expected value for the filter (used with JSON Path)',
						displayOptions: {
							show: {
								valueFilter: [true],
							},
						},
					},
				],
			},
			{
				displayName: 'Advanced Options',
				name: 'advancedOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Heartbeat Interval (Ms)',
						name: 'heartbeatInterval',
						type: 'number',
						default: 3000,
						description: 'How often the consumer sends heartbeat to Kafka',
					},
					{
						displayName: 'Session Timeout (Ms)',
						name: 'sessionTimeout',
						type: 'number',
						default: 30000,
						description: 'Consumer session timeout',
					},
					{
						displayName: 'Max Wait Time (Ms)',
						name: 'maxWaitTimeInMs',
						type: 'number',
						default: 5000,
						description: 'Maximum time to wait for fetch request',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const credentials = await this.getCredentials('kafka', i);
				const topicName = this.getNodeParameter('topicName', i) as string;
				const groupId = this.getNodeParameter('groupId', i) as string;
				const timeoutSeconds = this.getNodeParameter('timeoutSeconds', i) as number;
				const readFromBeginning = this.getNodeParameter('readFromBeginning', i) as boolean;
				const filterOptions = this.getNodeParameter('filterOptions', i) as {
					keyFilter?: string;
					valueFilter?: string;
					expectedValue?: string;
				};
				const advancedOptions = this.getNodeParameter('advancedOptions', i) as {
					heartbeatInterval?: number;
					sessionTimeout?: number;
					maxWaitTimeInMs?: number;
				};

				// Setup Kafka configuration
				const kafkaConfig: KafkaConfig = {
					clientId: credentials.clientId as string || 'n8n-kafka-wait-event',
					brokers: (credentials.brokers as string).split(',').map(broker => broker.trim()),
					ssl: credentials.ssl as boolean || false,
					logLevel: logLevel.WARN,
				};

				// Add SASL authentication if configured
				if (credentials.authentication) {
					kafkaConfig.sasl = {
						mechanism: credentials.saslMechanism as string || 'plain',
						username: credentials.username as string,
						password: credentials.password as string,
					} as SASLOptions;
				}

				const kafka = new ApacheKafka(kafkaConfig);
				const consumer = kafka.consumer({
					groupId: groupId, // Keep consistent group ID for offset tracking
					heartbeatInterval: advancedOptions.heartbeatInterval || 3000,
					sessionTimeout: advancedOptions.sessionTimeout || 30000,
					maxWaitTimeInMs: advancedOptions.maxWaitTimeInMs || 5000,
					allowAutoTopicCreation: false, // Prevent accidental topic creation
				});

				// Wait for message with timeout
				const messagePromise = new Promise<INodeExecutionData>((resolve, reject) => {
					let isResolved = false;

					// Setup timeout
					const timeout = setTimeout(() => {
						if (!isResolved) {
							isResolved = true;
							consumer.disconnect().finally(() => {
								reject(new NodeOperationError(
									this.getNode(),
									`Timeout waiting for Kafka message after ${timeoutSeconds} seconds`,
									{ itemIndex: i }
								));
							});
						}
					}, timeoutSeconds * 1000);

					// Setup message handler
					const handleMessage = async (payload: any) => {
						if (isResolved) return;

						const { topic, partition, message } = payload;

						try {
							let messageData: any = {};

							// Parse message key and value
							const key = message.key ? message.key.toString() : null;
							let value: any = null;

							if (message.value) {
								try {
									value = JSON.parse(message.value.toString());
								} catch {
									value = message.value.toString();
								}
							}

							// Apply filters
							let passesFilter = true;

							// Key filter
							if (filterOptions.keyFilter && key !== filterOptions.keyFilter) {
								passesFilter = false;
							}

							// Value filter with JSONPath
							if (passesFilter && filterOptions.valueFilter && filterOptions.expectedValue) {
								try {
									const JSONPath = require('jsonpath');
									const extractedValue = JSONPath.value(value, filterOptions.valueFilter);
									if (extractedValue !== filterOptions.expectedValue) {
										passesFilter = false;
									}
								} catch (error) {
									// JSONPath extraction failed, skip this message
									passesFilter = false;
								}
							}

							if (passesFilter) {
								isResolved = true;
								clearTimeout(timeout);

								messageData = {
									topic,
									partition,
									offset: message.offset,
									key,
									value,
									timestamp: message.timestamp,
									headers: message.headers,
								};

								resolve({
									json: messageData,
									pairedItem: { item: i },
								});
							}
						} catch (error) {
							if (!isResolved) {
								isResolved = true;
								clearTimeout(timeout);
								await consumer.disconnect();
								reject(new NodeOperationError(
									this.getNode(),
									`Error processing Kafka message: ${error.message}`,
									{ itemIndex: i }
								));
							}
						}
					};

					// Start consuming with retry logic
					const startConsuming = async () => {
						const maxRetries = 3;
						for (let attempt = 1; attempt <= maxRetries; attempt++) {
							try {
								await consumer.connect();
								await consumer.subscribe({
									topic: topicName,
									fromBeginning: readFromBeginning,
								});

								await consumer.run({
									eachMessage: handleMessage,
								});
								break; // Success, exit retry loop
							} catch (error) {

								if (attempt === maxRetries) {
									// Final attempt failed
									if (!isResolved) {
										isResolved = true;
										clearTimeout(timeout);
										reject(new NodeOperationError(
											this.getNode(),
											`Failed to connect to Kafka after ${maxRetries} attempts: ${error.message}`,
											{ itemIndex: i }
										));
									}
								} else {
									// Wait before retry
									await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
								}
							}
						}
					};

					startConsuming();
				});

				try {
					const result = await messagePromise;
					results.push(result);
				} finally {
					// Ensure proper cleanup
					try {
						await consumer.disconnect();
					} catch (disconnectError) {
						// Silently handle disconnect errors
					}
				}

			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: { error: error.message },
						pairedItem: { item: i },
					});
				} else {
					throw error;
				}
			}
		}

		return [results];
	}
}