pipeline {
    agent {
        kubernetes {
            yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: builder
    image: gradle:8-jdk21
'''
        }
    }
    options { skipDefaultCheckout() }
    environment {
        DB = credentials('db-creds')
    }
    stages {
        stage('Prepare') {
            steps {
                checkout([$class: 'GitSCM', branches: [[name: '*/main']], extensions: [[$class: 'SubmoduleOption', recursiveSubmodules: true]], userRemoteConfigs: [[url: 'https://github.com/acme/widgets.git', credentialsId: 'gh-token']]])
                script {
                    def shortSha = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.SHORT_SHA = shortSha
                    if (fileExists('gradlew')) {
                        echo 'wrapper present'
                    }
                }
            }
        }
        stage('Build') {
            steps {
                sh './gradlew build -PdbUser=$DB_USR -PdbPass=$DB_PSW'
            }
        }
        stage('Package on Windows') {
            agent { label 'windows-2022' }
            steps {
                powershell 'Compress-Archive -Path build\\libs\\* -DestinationPath app.zip'
                archiveArtifacts artifacts: 'app.zip', allowEmptyArchive: true
            }
        }
    }
    post {
        unstable { echo 'flaky' }
        cleanup { deleteDir() }
    }
}
