const core = require("@serverless-devs/core");
const _ = core.lodash;
const logger = new core.Logger('init-fc-alias');

module.exports = async function (inputs, args) {
  const step = _.get(args, 'step');
  const isPreStrp = step === 'pre';
  const isPostStrp = step === 'post';
  if (!(isPreStrp || isPostStrp)) {
    logger.debug(`step ${step} is not pre or post`);
    return inputs;
  }
  // 验证 trigger 是否配置 qualifier，没有配置则 skip。
  const triggers = _.cloneDeep(_.get(inputs, 'props.triggers', []));
  if (_.isEmpty(triggers)) {
    logger.debug('No triggers, skipp');
    return inputs;
  }

  // 获取参数
  const region = _.get(inputs, 'props.region');
  const serviceName = _.get(inputs, 'props.service.name');
  if (_.isEmpty(region)) {
    logger.debug('Invalid region specified in props.region, skip.');
    return inputs;
  }
  if (_.isEmpty(serviceName)) {
    logger.debug('Invalid serviceName specified.');
    return inputs;
  }
  const functionName = _.get(inputs, 'props.function.name');

  const fcClient = await getFcClient(inputs);
  if (isPreStrp) {
    const needDeployTrigger = await pre({
      fcClient,
      triggers,
      serviceName,
      functionName,
    });

    logger.info(`triggers updated: ${JSON.stringify(needDeployTrigger)}`);
    _.set(inputs, 'props.triggers', needDeployTrigger);
  }

  if (isPostStrp) {
    const parsedArgs = core.commandParse(inputs);
    const subCommand = _.get(parsedArgs, 'rawData[0]');
    logger.debug(`post subCommand is: ${subCommand}`);
    if (subCommand === 'publish') {
      const aliasName = _.get(parsedArgs, 'data[alias-name]');
      logger.debug(`aliasName is: ${aliasName}`);
      await post({
        fcClient,
        serviceName,
        functionName,
        triggers,
        aliasName,
      });
    }
  }

  return inputs;
};

async function pre({
  fcClient,
  triggers,
  serviceName,
}) {
  // 如果配置了别名，并且别名不存在。deploy 不部署
  const needDeployTrigger = [];
  for (const trigger of triggers) {
    const { name, qualifier } = trigger;
    if (qualifier && !/^\d/.test(qualifier)) {
      try {
        await fcClient.getAlias(serviceName, qualifier)
        logger.debug(`alias ${qualifier} is existence, skip`);
        needDeployTrigger.push(trigger);
      } catch (ex) {
        // 如果不是 404 异常，则 skip
        if (!_.get(ex, 'message', '').includes('failed with 404')) {
          logger.debug(`get alias error: ${ex.message}`);
          needDeployTrigger.push(trigger);
        }
      }
    } else {
      needDeployTrigger.push(trigger);
    }
  }

  return needDeployTrigger;
}

async function post({
  fcClient,
  serviceName,
  functionName,
  triggers,
  aliasName,
}) {
  for (const triggerConfig of triggers) {
    const qualifier = _.get(triggerConfig, 'qualifier');
    if (qualifier !== aliasName) {
      continue;
    }
    const triggerName = _.get(triggerConfig, 'name');
    const triggerType = _.get(triggerConfig, 'type');
    const headers = triggerType === 'eventbridge' ? {
      'x-fc-enable-eventbridge-trigger': 'enable',
    } : undefined;

    logger.debug('Create trigger...');
    let hasTrigger = false;
    try {
      await fcClient.getTrigger(serviceName, functionName, triggerName, headers);
      hasTrigger = true;
    } catch (ex) {
      logger.debug(`makeTrigger error message: ${ex.toString()}`);
    }

    const options = {
      triggerConfig: triggerConfig.config,
      triggerType,
      triggerName,
      qualifier,
    };

    try {
      if (hasTrigger) {
        await fcClient.updateTrigger(serviceName, functionName, triggerName, options, headers);
      } else {
        await fcClient.createTrigger(serviceName, functionName, options, headers);
      }
      logger.debug('Created trigger success.');
    } catch (ex) {
      if (ex.message.includes('Updating trigger is not supported yet.')) {
        logger.warn(
          `Updating ${serviceName}/${functionName}/${triggerName} is not supported yet.`,
        );
      } else {
        throw ex;
      }
    }
  }
}

// 创建 client
async function getFcClient(inputs) {
  const access = _.get(inputs, 'project.access');
  const region = _.get(inputs, 'props.region');
  const credentials = _.get(inputs, 'credentials', {});
  const fcCore = await core.loadComponent('devsapp/fc-core');
  return await fcCore.makeFcClient({
    access,
    credentials,
    region,
  });
}
