import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as cpactions from '@aws-cdk/aws-codepipeline-actions';
import * as events from '@aws-cdk/aws-events';
import * as iam from '@aws-cdk/aws-iam';
import { Construct } from '@aws-cdk/core';
import { embeddedAsmPath } from '../private/construct-internals';

/**
 * Props for the UpdatePipelineAction
 */
export interface UpdatePipelineActionProps {
  /**
   * The CodePipeline artifact that holds the Cloud Assembly.
   */
  readonly cloudAssemblyInput: codepipeline.Artifact;

  /**
   * Name of the pipeline stack
   */
  readonly pipelineStackName: string;

  /**
   * Version of CDK CLI to 'npm install'.
   *
   * @default - Latest version
   */
  readonly cdkCliVersion?: string;

  /**
   * Name of the CodeBuild project
   *
   * @default - Automatically generated
   */
  readonly projectName?: string;
}

/**
 * Action to self-mutate the pipeline
 *
 * Creates a CodeBuild project which will use the CDK CLI
 * to deploy the pipeline stack.
 *
 * You do not need to instantiate this action -- it will automatically
 * be added by the pipeline.
 */
export class UpdatePipelineAction extends Construct implements codepipeline.IAction {
  private readonly action: codepipeline.IAction;

  constructor(scope: Construct, id: string, props: UpdatePipelineActionProps) {
    super(scope, id);

    const installSuffix = props.cdkCliVersion ? `@${props.cdkCliVersion}` : '';

    const selfMutationProject = new codebuild.PipelineProject(this, 'SelfMutation', {
      projectName: props.projectName,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: `npm install -g aws-cdk${installSuffix}`,
          },
          build: {
            commands: [
              // Cloud Assembly is in *current* directory.
              `cdk -a ${embeddedAsmPath(scope)} deploy ${props.pipelineStackName} --require-approval=never --verbose`,
            ],
          },
        },
      }),
    });

    // allow the self-mutating project permissions to assume the bootstrap Action role
    selfMutationProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['arn:*:iam::*:role/*-deploy-role-*', 'arn:*:iam::*:role/*-publishing-role-*'],
    }));
    selfMutationProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: ['*'], // this is needed to check the status of the bootstrap stack when doing `cdk deploy`
    }));
    // S3 checks for the presence of the ListBucket permission
    selfMutationProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: ['*'],
    }));
    this.action = new cpactions.CodeBuildAction({
      actionName: 'SelfMutate',
      input: props.cloudAssemblyInput,
      project: selfMutationProject,
    });
  }

  /**
   * Exists to implement IAction
   */
  public bind(scope: Construct, stage: codepipeline.IStage, options: codepipeline.ActionBindOptions):
  codepipeline.ActionConfig {
    return this.action.bind(scope, stage, options);
  }

  /**
   * Exists to implement IAction
   */
  public onStateChange(name: string, target?: events.IRuleTarget, options?: events.RuleProps): events.Rule {
    return this.action.onStateChange(name, target, options);
  }

  /**
   * Exists to implement IAction
   */
  public get actionProperties(): codepipeline.ActionProperties {
    // FIXME: I have had to make this class a Construct, because:
    //
    // - It needs access to the Construct tree, because it is going to add a `PipelineProject`.
    // - I would have liked to have done that in bind(), however,
    // - `actionProperties` (this method) is called BEFORE bind() is called, and by that point I
    //   don't have the "inner" Action yet to forward the call to.
    //
    // I've therefore had to construct the inner CodeBuildAction in the constructor, which requires making this
    // Action a Construct.
    //
    // Combined with how non-intuitive it is to make the "StackDeployAction", I feel there is something
    // wrong with the Action abstraction here.
    return this.action.actionProperties;
  }
}
