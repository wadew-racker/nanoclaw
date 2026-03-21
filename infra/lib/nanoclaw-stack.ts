import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class NanoclawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // VPC: single public subnet, no NAT gateway
    // The instance needs outbound internet access (Bedrock, WhatsApp, Telegram,
    // npm, apt) but accepts no inbound connections — SSM Session Manager reaches
    // the instance via outbound HTTPS from the instance to the SSM endpoints.
    // -------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // NACL: stateless subnet-level firewall
    //
    // Inbound strategy: only allow ephemeral ports (1024-65535), which are the
    // return ports for connections the instance itself initiated. This blocks
    // any inbound-initiated traffic on well-known ports (22, 80, 443, etc.)
    // without needing explicit DENY rules for each one.
    //
    // Outbound strategy: allow HTTPS (443), HTTP (80), DNS (53 TCP+UDP), and
    // the ephemeral port range for outbound connections to high-port services.
    //
    // Note: NACLs are stateless, so both directions must be explicitly allowed.
    // -------------------------------------------------------------------------
    const nacl = new ec2.NetworkAcl(this, 'PublicNacl', {
      vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Inbound: return traffic for outbound-initiated TCP connections
    nacl.addEntry('InboundEphemeralTcp', {
      ruleNumber: 100,
      traffic: ec2.AclTraffic.tcpPortRange(1024, 65535),
      direction: ec2.TrafficDirection.INGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // Inbound: return traffic for outbound-initiated UDP (e.g. DNS responses)
    nacl.addEntry('InboundEphemeralUdp', {
      ruleNumber: 110,
      traffic: ec2.AclTraffic.udpPortRange(1024, 65535),
      direction: ec2.TrafficDirection.INGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // All other inbound is denied by the implicit NACL deny-all rule.

    // Outbound: HTTPS — Bedrock, SSM endpoints, WhatsApp, Telegram, GitHub, npm
    nacl.addEntry('OutboundHTTPS', {
      ruleNumber: 100,
      traffic: ec2.AclTraffic.tcpPort(443),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // Outbound: HTTP — package repos (dnf, apt), redirects
    nacl.addEntry('OutboundHTTP', {
      ruleNumber: 110,
      traffic: ec2.AclTraffic.tcpPort(80),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // Outbound: DNS over UDP
    nacl.addEntry('OutboundDnsUdp', {
      ruleNumber: 120,
      traffic: ec2.AclTraffic.udpPort(53),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // Outbound: DNS over TCP (large responses, DNSSEC)
    nacl.addEntry('OutboundDnsTcp', {
      ruleNumber: 125,
      traffic: ec2.AclTraffic.tcpPort(53),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // Outbound: ephemeral ports — covers connections to services on high ports
    nacl.addEntry('OutboundEphemeralTcp', {
      ruleNumber: 130,
      traffic: ec2.AclTraffic.tcpPortRange(1024, 65535),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
      cidr: ec2.AclCidr.anyIpv4(),
    });

    // -------------------------------------------------------------------------
    // Security group: no inbound rules, all outbound allowed
    // This is the instance-level firewall (stateful). The zero-inbound policy
    // means no connection can be initiated from the internet to this instance.
    // SSM Session Manager works via outbound HTTPS — no inbound port required.
    // -------------------------------------------------------------------------
    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description:
        'NanoClaw EC2 — no inbound, outbound only. Access via SSM Session Manager.',
      allowAllOutbound: true,
    });

    // -------------------------------------------------------------------------
    // IAM instance role
    //
    // AmazonSSMManagedInstanceCore: enables SSM Session Manager (replaces SSH),
    //   Run Command, Parameter Store, and Patch Manager.
    //
    // BedrockInvoke: scoped to all Anthropic foundation models across all
    //   regions. Adjust the resource ARN if you want to lock down to a specific
    //   region or model.
    // -------------------------------------------------------------------------
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'NanoClaw EC2 instance role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore',
        ),
      ],
    });

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        // Allows all Anthropic models in all regions. Narrow to a specific
        // region or model ID (e.g. anthropic.claude-sonnet-4-5-*) if desired.
        resources: ['arn:aws:bedrock:*::foundation-model/anthropic.*'],
      }),
    );

    // -------------------------------------------------------------------------
    // User data: install prerequisites only.
    // Cloning the repo and running /setup is a manual step done over SSM after
    // the instance is running.
    // -------------------------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -e',
      'dnf update -y',

      '# Docker',
      'dnf install -y docker',
      'systemctl enable --now docker',
      'usermod -aG docker ec2-user',

      '# Node.js 24 via NodeSource',
      'curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -',
      'dnf install -y nodejs',

      '# Git and essentials',
      'dnf install -y git',

      'echo "NanoClaw prerequisites ready. Connect via SSM and run /setup."',
    );

    // -------------------------------------------------------------------------
    // EC2 instance
    //
    // t4g.small: 2 vCPU, 2 GB RAM, ARM/Graviton — ~$15/month on-demand.
    // Enough headroom for the Node.js host process plus a running agent
    // container (Node + Claude Code SDK, ~400-600 MB peak).
    //
    // Amazon Linux 2023 ARM: AWS-maintained, Docker-compatible, dnf-based.
    // -------------------------------------------------------------------------
    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.SMALL,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: instanceSg,
      role: instanceRole,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      userData,
      // Require IMDSv2 — prevents SSRF attacks from reaching instance metadata
      requireImdsv2: true,
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: instance.instancePublicIp,
      description: 'Public IP (for reference — not used for direct access)',
    });

    new cdk.CfnOutput(this, 'SsmConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId}`,
      description: 'Connect to the instance (no SSH required)',
    });
  }
}
