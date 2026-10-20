pipeline {
    agent { label 'linux && docker' }
    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds(abortPrevious: true)
        buildDiscarder(logRotator(numToKeepStr: '20'))
        timestamps()
    }
    environment {
        REGISTRY = 'ghcr.io/acme'
        IMAGE = "${REGISTRY}/api:${env.BUILD_NUMBER}"
        SONAR_TOKEN = credentials('sonar-token')
        MAVEN_OPTS = '-Xmx2g'
    }
    parameters {
        string(name: 'DEPLOY_ENV', defaultValue: 'staging', description: 'Target environment')
        booleanParam(name: 'RUN_E2E', defaultValue: false, description: 'Run end-to-end tests')
        choice(name: 'LOG_LEVEL', choices: ['info', 'debug', 'trace'], description: 'Log level')
    }
    triggers {
        cron('H 2 * * 1-5')
        pollSCM('H/15 * * * *')
    }
    tools {
        jdk 'temurin-17'
        maven 'maven-3.9'
    }
    stages {
        stage('Checkout') {
            steps {
                checkout scm
                sh 'git rev-parse --short HEAD > commit.txt'
            }
        }
        stage('Build') {
            steps {
                sh 'mvn -B -ntp clean package -DskipTests'
                archiveArtifacts artifacts: 'target/*.jar', fingerprint: true
                stash name: 'jar', includes: 'target/*.jar'
            }
        }
        stage('Test') {
            when { not { branch 'release/*' } }
            steps {
                sh '''
                    mvn -B -ntp test
                    echo "Tests done on ${BRANCH_NAME}"
                '''
            }
            post {
                always {
                    junit 'target/surefire-reports/*.xml'
                }
            }
        }
        stage('Docker') {
            when { anyOf { branch 'main'; branch 'develop' } }
            steps {
                unstash 'jar'
                withCredentials([usernamePassword(credentialsId: 'ghcr-creds', usernameVariable: 'DOCKER_USER', passwordVariable: 'DOCKER_PASS')]) {
                    sh 'echo "$DOCKER_PASS" | docker login ghcr.io -u "$DOCKER_USER" --password-stdin'
                    sh "docker build -t ${IMAGE} ."
                    sh "docker push ${IMAGE}"
                }
            }
        }
        stage('Deploy') {
            when {
                branch 'main'
                expression { return params.DEPLOY_ENV != 'none' }
            }
            steps {
                timeout(time: 10, unit: 'MINUTES') {
                    retry(3) {
                        sh "./deploy.sh ${params.DEPLOY_ENV} --log-level ${params.LOG_LEVEL}"
                    }
                }
                dir('e2e') {
                    sh 'npm ci && npm test'
                }
            }
        }
    }
    post {
        success {
            slackSend channel: '#builds', message: "Build ${env.BUILD_URL} succeeded"
        }
        failure {
            mail to: 'team@example.com', subject: "Failed: ${env.JOB_NAME}", body: 'See Jenkins'
        }
        always {
            cleanWs()
        }
    }
}
